import { config } from "../config.js";
import type { Db } from "../db.js";
import { Policy, ACTION_LABEL } from "../policy.js";
import { formatDateTime } from "../time.js";
import type { ExtensionBridge } from "../ws.js";

export const HELP = `Sou a ${config.assistantName}. Fale comigo em linguagem natural. Alguns atalhos:
- *status* · *pendentes* · *contatos* · *ajuda*
- *pausa* / *retoma* o atendimento a familiares
- *autoriza N* libera um número desconhecido (N vem do aviso) · *ignora N*
- Encaminhe um *cartão de contato* para autorizar alguém
- Propostas: *ok N* · *não N* · *N: texto novo* (ou responda citando a proposta)
Exemplos: "anota: ligar pro contador até sexta", "o que tenho pendente?", "avisa a mãe que chego às 20h", "lembra a mãe amanhã às 9 do exame", "pode responder a mãe sem me perguntar".`;

interface CommandCtx {
  db: Db;
  policy: Policy;
  bridge: ExtensionBridge;
}

/** Comandos determinísticos do dono. Retorna texto de resposta ou null para delegar ao agente. */
export function handleOwnerCommand(ctx: CommandCtx, text: string): string | null {
  const t = text.trim().toLowerCase();
  const { db, policy } = ctx;

  if (/^(ajuda|help|\?)$/.test(t)) return HELP;

  if (/^(status|situa[çc][ãa]o)$/.test(t)) {
    const family = db.listContacts("family");
    const lines = [
      `Estado: ${policy.isPaused() ? "pausada" : "ativa"} · WhatsApp Web: ${ctx.bridge.pageState.ready ? "conectado" : "desconectado"}`,
      `Tarefas abertas suas: ${db.listTasks({ assignee_id: null }).length} · de familiares: ${db.listTasks({ assignee_id: "all" }).filter((x) => x.assignee_id).length}`,
      `Lembretes pendentes: ${db.pendingReminders().length} · Propostas aguardando: ${db.pendingProposals().length}`,
      `Contatos autorizados (${family.length}): ${family.map((c) => c.name).join(", ") || "nenhum"}`,
    ];
    const unk = db.pendingUnknown();
    if (unk.length) lines.push(`Desconhecidos aguardando: ${unk.map((u) => `#${u.id} ${u.name ?? u.phone ?? u.wa_id}`).join(", ")}`);
    return lines.join("\n");
  }

  if (/^(pausa|pausar|pause|silêncio|silencio)$/.test(t)) {
    policy.setPaused(true);
    db.audit("paused", { paused: true });
    return "Pausei o atendimento a familiares. Continuo falando só com você. Diga *retoma* para voltar.";
  }
  if (/^(retoma|retomar|volta|voltar|resume|ativa)$/.test(t)) {
    policy.setPaused(false);
    db.audit("paused", { paused: false });
    return "Retomei o atendimento a familiares.";
  }

  if (/^(pendentes|propostas|aprova[çc][õo]es)$/.test(t)) {
    const ps = db.pendingProposals();
    if (!ps.length) return "Nenhuma proposta aguardando sua aprovação.";
    return ps
      .map((p) => `#${p.id} → ${db.getContact(p.target_id)?.name ?? p.target_id} (${ACTION_LABEL[p.action]})\n"${p.body}"\nexpira ${formatDateTime(p.expires_at)}`)
      .join("\n\n");
  }

  if (/^(contatos|autorizados)$/.test(t)) {
    const cs = db.listContacts("family");
    if (!cs.length) return "Nenhum contato autorizado ainda. Encaminhe um cartão de contato ou diga: autoriza 5551999998888 Nome.";
    return cs.map((c) => `- ${c.name}${c.phone ? " +" + c.phone : ""} · ${policy.describe(c)}`).join("\n");
  }

  let m = /^(autoriza|autorizar|libera|liberar)\s+#?(\d{1,4})(?:\s+(.+))?$/.exec(t);
  if (m) {
    const u = db.getUnknown(Number(m[2]));
    if (!u) return `Não achei o desconhecido #${m[2]}.`;
    const name = m[3] ? text.trim().slice(text.trim().length - m[3].length).trim() : (u.name ?? `Contato ${u.id}`);
    const c = db.upsertContact({ id: u.wa_id, name, phone: u.phone, role: "family", notes: null });
    db.setUnknownStatus(u.id, "authorized");
    db.audit("contact_authorized", c);
    return `${c.name} autorizado(a). Política: ${policy.describe(c)}.`;
  }
  m = /^(autoriza|autorizar|libera|liberar)\s+\+?([\d\s().-]{8,})\s+(.+)$/.exec(text.trim());
  if (m) {
    const phone = m[2].replace(/\D/g, "");
    const name = m[3].trim();
    const existing = db.findContact(undefined, phone);
    const c = db.upsertContact({ id: existing?.id ?? `${phone}@c.us`, name, phone, role: "family", notes: null });
    db.audit("contact_authorized", c);
    return `${c.name} (+${phone}) autorizado(a). Política: ${policy.describe(c)}.`;
  }
  m = /^(ignora|ignorar|bloqueia|bloquear)\s+#?(\d{1,4})$/.exec(t);
  if (m) {
    const u = db.getUnknown(Number(m[2]));
    if (!u) return `Não achei o desconhecido #${m[2]}.`;
    db.setUnknownStatus(u.id, "ignored");
    return `Ok, vou ignorar ${u.name ?? u.phone ?? u.wa_id}.`;
  }

  return null;
}
