import { config } from "../config.js";
import type { Contact, Db } from "../db.js";
import { log, warn } from "../log.js";
import type { Outbox } from "../outbox.js";
import type { Policy } from "../policy.js";
import type { Agent } from "../agent/claude.js";
import type { ExtensionBridge, InboundMessage } from "../ws.js";
import { parseApproval } from "./approvals.js";
import { HELP, handleOwnerCommand } from "./commands.js";
import { parseVcard } from "./vcard.js";

const UNKNOWN_NOTIFY_INTERVAL_MS = 6 * 3600_000;
const MEDIA_LABEL: Record<string, string> = {
  ptt: "um áudio",
  audio: "um áudio",
  image: "uma imagem",
  video: "um vídeo",
  document: "um documento",
  sticker: "uma figurinha",
  location: "uma localização",
};

export class InboundRouter {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private db: Db,
    private bridge: ExtensionBridge,
    private outbox: Outbox,
    private policy: Policy,
    private agent: Agent,
  ) {}

  /** Processa mensagens em série, na ordem de chegada. */
  enqueue(msg: InboundMessage): void {
    this.queue = this.queue.then(() => this.handle(msg)).catch((e) => warn("inbound", "erro não tratado", e));
  }

  private async handle(msg: InboundMessage): Promise<void> {
    if (msg.fromMe) return; // mensagens enviadas pela própria conta (inclusive pela Aia)
    if (msg.isGroup || /@g\.us$/.test(msg.chatId) || msg.chatId === "status@broadcast" || /@broadcast$/.test(msg.chatId)) return;
    if (msg.type === "e2e_notification" || msg.type === "notification_template" || msg.type === "gp2" || msg.type === "call_log") return;
    if (this.db.hasMessage(msg.id)) return;

    const senderId = msg.from ?? msg.chatId;
    const body = (msg.body ?? "").trim();
    const contact = this.db.findContact(senderId, msg.senderPhone);
    const owner = this.db.getOwner();

    // Pareamento do dono: "pareia 123456" (ou telefone configurado em OWNER_PHONE)
    if (!owner || contact?.role !== "owner") {
      const paired = await this.tryPairOwner(msg, senderId, body);
      if (paired) return;
    }

    if (contact && contact.id !== senderId) {
      // Autorizado pelo telefone, mas escreveu com outro ID (ex.: @lid). Reatamos.
      this.db.rebindContactId(contact.id, senderId);
      log("inbound", `contato ${contact.name} reatado de ${contact.id} para ${senderId}`);
      contact.id = senderId;
    }

    const textForHistory = this.describeContent(msg, body);
    this.db.saveMessage({ wa_id: msg.id, chat_id: senderId, contact_id: contact?.id ?? null, direction: "in", body: textForHistory, type: msg.type, ts: msg.t ? msg.t * 1000 : Date.now() });

    if (!contact) return this.handleUnknown(msg, senderId, body);
    if (contact.role === "blocked") return;
    if (contact.role === "owner") return this.handleOwner(contact, msg, body);
    return this.handleFamily(contact, msg, body);
  }

  private describeContent(msg: InboundMessage, body: string): string {
    if (msg.type === "chat" || body) return body || `[${msg.type}]`;
    if (msg.type === "vcard" || msg.type === "multi_vcard") return `[cartão de contato: ${msg.vcards.map((v) => parseVcard(v)?.name ?? "?").join(", ")}]`;
    return `[enviou ${MEDIA_LABEL[msg.type] ?? "uma mídia (" + msg.type + ")"}]`;
  }

  private async tryPairOwner(msg: InboundMessage, senderId: string, body: string): Promise<boolean> {
    const code = this.db.getSetting("pairing_code");
    const m = /^(?:aia\s+)?pareia(?:r)?\s+(\d{6})$/i.exec(body);
    const byCode = !!(m && code && m[1] === code);
    const byPhone = !!(config.ownerPhone && msg.senderPhone && msg.senderPhone === config.ownerPhone);
    if (!byCode && !byPhone) return false;
    const existingOwner = this.db.getOwner();
    if (existingOwner && existingOwner.id !== senderId) {
      this.db.rebindContactId(existingOwner.id, senderId);
    } else if (!existingOwner) {
      this.db.upsertContact({ id: senderId, name: config.ownerName, phone: msg.senderPhone ?? config.ownerPhone ?? null, role: "owner", notes: "dono" });
    }
    this.db.setSetting("pairing_code", "");
    this.db.audit("owner_paired", { id: senderId, byCode, byPhone });
    log("inbound", `dono pareado: ${senderId}`);
    this.db.saveMessage({ wa_id: msg.id, chat_id: senderId, contact_id: senderId, direction: "in", body, type: msg.type });
    await this.outbox.notifyOwner(`Pronto, ${config.ownerName}. Estou ativa e reconheço este número como seu.\n\n${HELP}`);
    return true;
  }

  private async handleUnknown(msg: InboundMessage, senderId: string, body: string): Promise<void> {
    const u = this.db.touchUnknown({ wa_id: senderId, phone: msg.senderPhone ?? null, name: msg.notifyName ?? null, body: body || `[${msg.type}]` });
    if (u.status === "ignored") return;
    if (u.status === "authorized") {
      // Já autorizado antes mas não casou com contato (inconsistência): reautoriza em silêncio como pendente.
      this.db.setUnknownStatus(u.id, "pending");
    }
    const owner = this.db.getOwner();
    if (!owner) {
      log("inbound", `mensagem de desconhecido antes do pareamento: ${senderId}`);
      return;
    }
    if (u.last_notified && Date.now() - u.last_notified < UNKNOWN_NOTIFY_INTERVAL_MS) return;
    this.db.markUnknownNotified(u.id);
    const who = `${u.name ?? "sem nome"}${u.phone ? " (+" + u.phone + ")" : ""}`;
    await this.outbox.notifyOwner(`👤 Número desconhecido #${u.id}: ${who} escreveu:\n"${(body || `[${msg.type}]`).slice(0, 300)}"\n\nResponda *autoriza ${u.id} Nome* para liberar, ou *ignora ${u.id}*.`);
  }

  private async handleOwner(owner: Contact, msg: InboundMessage, body: string): Promise<void> {
    // 1) Cartão de contato encaminhado = autorização direta
    if (msg.vcards.length) {
      const added: string[] = [];
      for (const v of msg.vcards) {
        const vc = parseVcard(v);
        if (!vc || !vc.phone) continue;
        const existing = this.db.findContact(undefined, vc.phone);
        const c = this.db.upsertContact({ id: existing?.id ?? `${vc.phone}@c.us`, name: existing?.name ?? vc.name, phone: vc.phone, role: existing?.role === "owner" ? "owner" : "family", notes: null });
        if (c.role === "family") added.push(`${c.name} (+${vc.phone})`);
      }
      const reply = added.length ? `Autorizei: ${added.join(", ")}. Começam pedindo seu ok para tudo; diga "pode responder a X sem me perguntar" quando quiser liberar.` : "Não consegui ler um telefone nesse cartão.";
      await this.outbox.notifyOwner(reply);
      return;
    }

    if (!body) {
      if (MEDIA_LABEL[msg.type]) await this.outbox.notifyOwner(`Por enquanto só leio texto. Pode me mandar por escrito?`);
      return;
    }

    // 2) Aprovações (ok 12 / não 12 / 12: texto / resposta citando a proposta)
    const approval = parseApproval(body);
    const quoted = msg.quotedMsgId ? this.db.proposalByNotifyMsg(msg.quotedMsgId) : null;
    if (approval || quoted) {
      const handled = await this.applyApproval(approval, quoted, body);
      if (handled) return;
    }

    // 3) Comandos fixos
    const cmd = handleOwnerCommand({ db: this.db, policy: this.policy, bridge: this.bridge }, body);
    if (cmd) {
      await this.outbox.notifyOwner(cmd);
      return;
    }

    // 4) Agente
    if (!this.agent.available) {
      await this.outbox.notifyOwner("Ainda estou sem a chave da API configurada no servidor (.env). Comandos fixos funcionam: *ajuda*.");
      return;
    }
    const reply = await this.agent.respond(owner, owner.id);
    if (reply) await this.outbox.notifyOwner(reply);
  }

  private async applyApproval(approval: ReturnType<typeof parseApproval>, quoted: ReturnType<Db["proposalByNotifyMsg"]>, body: string): Promise<boolean> {
    let proposal = quoted;
    if (approval && approval.id !== null) proposal = this.db.getProposal(approval.id) ?? proposal;
    if (!proposal && approval && approval.id === null) proposal = this.db.latestPendingProposal();
    if (!proposal) {
      if (approval && approval.kind !== "edit" && approval.id !== null) {
        await this.outbox.notifyOwner(`Não achei a proposta #${approval.id}.`);
        return true;
      }
      return false; // "ok" solto sem proposta pendente: deixa o agente interpretar
    }
    if (proposal.status !== "pending") {
      await this.outbox.notifyOwner(`A proposta #${proposal.id} já está ${proposal.status === "sent" ? "enviada" : proposal.status}.`);
      return true;
    }
    const target = this.db.getContact(proposal.target_id);
    const name = target?.name ?? proposal.target_id;

    if (approval?.kind === "reject") {
      this.outbox.reject(proposal);
      await this.outbox.notifyOwner(`Proposta #${proposal.id} para ${name} cancelada.`);
      return true;
    }
    let newText: string | undefined;
    if (approval?.kind === "edit") newText = approval.text;
    else if (!approval && quoted) newText = body; // respondeu citando a proposta com um texto novo
    const r = await this.outbox.approve(proposal, newText);
    await this.outbox.notifyOwner(r.ok ? `✅ Enviei para ${name}${newText ? " com seu texto" : ""}.` : `Não consegui enviar para ${name} (${r.error}). A proposta #${proposal.id} fica como falha; me peça para tentar de novo.`);
    return true;
  }

  private async handleFamily(contact: Contact, msg: InboundMessage, body: string): Promise<void> {
    if (this.policy.isPaused()) {
      log("inbound", `pausada; ignorando ${contact.name}`);
      return;
    }
    if (!this.agent.available) {
      warn("inbound", "sem API; mensagem de familiar ficou sem resposta");
      return;
    }
    if (this.policy.level(contact, "reply") === 0) return;

    void this.bridge.markRead(contact.id);
    const reply = await this.agent.respond(contact, contact.id);
    if (!reply) return;
    const lastIn = this.db.lastInbound(contact.id);
    const reason = `respondendo a: "${(lastIn?.body ?? body).slice(0, 120)}"`;
    await this.outbox.request({ target: contact, text: reply, action: "reply", reason, quotedMsgId: undefined });
  }
}
