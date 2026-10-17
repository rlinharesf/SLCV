import { config } from "./config.js";
import type { AutonomyAction, Contact, Db, Proposal } from "./db.js";
import { log, warn } from "./log.js";
import { Policy, ACTION_LABEL } from "./policy.js";
import type { ExtensionBridge } from "./ws.js";

export interface SendRequest {
  target: Contact;
  text: string;
  action: AutonomyAction;
  reason?: string;
  reminderId?: number | null;
  quotedMsgId?: string;
}

export type SendOutcome =
  | { kind: "sent"; msgId?: string }
  | { kind: "proposed"; proposal: Proposal }
  | { kind: "forbidden" }
  | { kind: "failed"; error: string };

/**
 * Toda mensagem que sai passa por aqui. A decisão (o que dizer) é do agente;
 * a permissão (se pode sair agora) é desta camada, com base na política.
 */
export class Outbox {
  constructor(
    private db: Db,
    private bridge: ExtensionBridge,
    private policy: Policy,
  ) {}

  /** Envio bruto, sem política. Usado para falar com o dono e para propostas aprovadas. */
  async deliver(target: Contact, text: string, quotedMsgId?: string): Promise<{ ok: boolean; msgId?: string; error?: string }> {
    const r = await this.bridge.sendText(target.id, text, quotedMsgId);
    if (r.ok) {
      this.db.saveMessage({ wa_id: r.msgId ?? null, chat_id: target.id, contact_id: target.id, direction: "out", body: text });
      this.db.audit("sent", { to: target.id, name: target.name, text, msgId: r.msgId });
    } else {
      warn("outbox", `falha ao enviar para ${target.name}: ${r.error}`);
      this.db.audit("send_failed", { to: target.id, name: target.name, text, error: r.error });
    }
    return r;
  }

  async notifyOwner(text: string): Promise<{ ok: boolean; msgId?: string }> {
    const owner = this.db.getOwner();
    if (!owner) {
      warn("outbox", "sem dono pareado; aviso descartado:", text.slice(0, 80));
      return { ok: false };
    }
    return this.deliver(owner, text);
  }

  /** Envio sujeito à política de autonomia. */
  async request(req: SendRequest): Promise<SendOutcome> {
    const { target, text, action } = req;
    if (target.role === "owner") {
      const r = await this.deliver(target, text, req.quotedMsgId);
      return r.ok ? { kind: "sent", msgId: r.msgId } : { kind: "failed", error: r.error ?? "?" };
    }
    const level = this.policy.level(target, action);
    this.db.audit("policy", { to: target.id, name: target.name, action, level, text });

    if (level === 0) return { kind: "forbidden" };

    if (level === 1) {
      const proposal = this.db.addProposal({
        target_id: target.id,
        action,
        body: text,
        reason: req.reason ?? null,
        expires_at: Date.now() + config.proposalTtlHours * 3600_000,
        reminder_id: req.reminderId ?? null,
      });
      const notice = this.formatProposal(proposal, target);
      const sent = await this.notifyOwner(notice);
      if (sent.msgId) this.db.updateProposal(proposal.id, { notify_msg_id: sent.msgId });
      if (config.ackEnabled && action === "reply") {
        await this.deliver(target, "Oi! Já vi sua mensagem, te retorno em instantes.");
      }
      log("outbox", `proposta #${proposal.id} criada para ${target.name}`);
      return { kind: "proposed", proposal: this.db.getProposal(proposal.id)! };
    }

    const r = await this.deliver(target, text, req.quotedMsgId);
    if (!r.ok) return { kind: "failed", error: r.error ?? "?" };
    if (level === 2) {
      await this.notifyOwner(`✅ Enviei para ${target.name} (${ACTION_LABEL[action]}):\n"${text}"`);
    }
    return { kind: "sent", msgId: r.msgId };
  }

  formatProposal(p: Proposal, target: Contact): string {
    const lines = [`📝 Proposta #${p.id} → ${target.name} (${ACTION_LABEL[p.action]})`, `"${p.body}"`];
    if (p.reason) lines.push(``, `Motivo: ${p.reason}`);
    lines.push(``, `Responda: *ok ${p.id}* · *não ${p.id}* · *${p.id}: novo texto*`);
    return lines.join("\n");
  }

  /** Aprova (e envia) uma proposta, opcionalmente com texto editado. */
  async approve(p: Proposal, newText?: string): Promise<{ ok: boolean; error?: string }> {
    const target = this.db.getContact(p.target_id);
    if (!target) return { ok: false, error: "contato não existe mais" };
    const body = newText?.trim() || p.body;
    const r = await this.deliver(target, body);
    this.db.updateProposal(p.id, { status: r.ok ? "sent" : "failed", body, decided_at: Date.now() });
    if (p.reminder_id) this.db.setReminderStatus(p.reminder_id, r.ok ? "sent" : "pending");
    this.db.audit("proposal_approved", { id: p.id, edited: !!newText, ok: r.ok });
    return { ok: r.ok, error: r.error };
  }

  reject(p: Proposal): void {
    this.db.updateProposal(p.id, { status: "rejected", decided_at: Date.now() });
    if (p.reminder_id) this.db.setReminderStatus(p.reminder_id, "cancelled");
    this.db.audit("proposal_rejected", { id: p.id });
  }
}
