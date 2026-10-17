import { config } from "./config.js";
import type { Db } from "./db.js";
import { ACTION_LABEL } from "./policy.js";
import { formatDateTime, formatDate } from "./time.js";

export function buildDigest(db: Db): string {
  const now = Date.now();
  const mine = db.listTasks({ assignee_id: null });
  const family = db.listTasks({ assignee_id: "all" }).filter((t) => t.assignee_id);
  const proposals = db.pendingProposals();
  const reminders = db.pendingReminders().filter((r) => r.fire_at <= now + 24 * 3600_000);
  const unknown = db.pendingUnknown();
  const name = (id: string | null) => (id ? db.getContact(id)?.name ?? "?" : config.ownerName);

  const lines: string[] = [`📋 Resumo do dia (${formatDate(now)})`];

  const overdue = mine.filter((t) => t.due_at && t.due_at < now);
  const today = mine.filter((t) => t.due_at && t.due_at >= now && t.due_at < now + 24 * 3600_000);
  const rest = mine.filter((t) => !overdue.includes(t) && !today.includes(t));

  if (!mine.length) lines.push("", "Suas pendências: nenhuma. 👌");
  else {
    if (overdue.length) {
      lines.push("", `*Atrasadas (${overdue.length})*`);
      for (const t of overdue) lines.push(`- #${t.id} ${t.title} (era ${formatDateTime(t.due_at!)})`);
    }
    if (today.length) {
      lines.push("", `*Próximas 24h (${today.length})*`);
      for (const t of today) lines.push(`- #${t.id} ${t.title} (${formatDateTime(t.due_at!)})`);
    }
    if (rest.length) {
      lines.push("", `*Demais pendências (${rest.length})*`);
      for (const t of rest.slice(0, 10)) lines.push(`- #${t.id} ${t.title}${t.due_at ? ` (${formatDateTime(t.due_at)})` : ""}`);
      if (rest.length > 10) lines.push(`- ... e mais ${rest.length - 10}`);
    }
  }

  if (family.length) {
    lines.push("", `*Pendências de familiares (${family.length})*`);
    for (const t of family.slice(0, 10)) lines.push(`- ${name(t.assignee_id)}: ${t.title}${t.due_at ? ` (${formatDateTime(t.due_at)})` : ""}`);
  }
  if (reminders.length) {
    lines.push("", `*Lembretes nas próximas 24h (${reminders.length})*`);
    for (const r of reminders) lines.push(`- ${formatDateTime(r.fire_at)} → ${name(r.target_id)}: ${r.message}`);
  }
  if (proposals.length) {
    lines.push("", `*Aguardando seu ok (${proposals.length})*`);
    for (const p of proposals) lines.push(`- #${p.id} → ${name(p.target_id)} (${ACTION_LABEL[p.action]}): "${p.body.slice(0, 80)}"`);
  }
  if (unknown.length) {
    lines.push("", `*Desconhecidos que escreveram (${unknown.length})*: ${unknown.map((u) => `#${u.id} ${u.name ?? u.phone ?? "?"}`).join(", ")}`);
  }
  return lines.join("\n");
}
