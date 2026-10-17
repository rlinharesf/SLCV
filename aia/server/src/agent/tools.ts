import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { AutonomyAction, Contact, Db, Level } from "../db.js";
import { Outbox } from "../outbox.js";
import { Policy, parseLevel, ACTION_LABEL, LEVEL_LABEL } from "../policy.js";
import { formatDateTime, localIsoToEpoch } from "../time.js";

export interface ToolContext {
  db: Db;
  outbox: Outbox;
  policy: Policy;
  /** Quem está falando com a Aia nesta conversa. */
  speaker: Contact;
  mode: "owner" | "contact";
}

type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function schema(properties: Record<string, unknown>, required: string[] = []): Anthropic.Tool.InputSchema {
  return { type: "object", properties, required, additionalProperties: false } as Anthropic.Tool.InputSchema;
}

const DUE_DESC = `Data/hora local no formato YYYY-MM-DDTHH:mm (fuso ${config.timezone}). Omita se não houver prazo.`;

export const OWNER_TOOLS: Anthropic.Tool[] = [
  {
    name: "add_task",
    description: "Cria uma tarefa/pendência. Se for para um familiar, informe assignee com o nome dele; se for do Ricardo, omita.",
    input_schema: schema(
      {
        title: { type: "string", description: "Título curto da tarefa" },
        details: { type: "string", description: "Detalhes opcionais" },
        assignee: { type: "string", description: "Nome do familiar responsável. Omita quando a tarefa é do Ricardo." },
        due_at: { type: "string", description: DUE_DESC },
        remind: { type: "boolean", description: "Se true e houver due_at, cria também um lembrete nesse horário para o responsável." },
      },
      ["title"],
    ),
  },
  {
    name: "list_tasks",
    description: "Lista tarefas. assignee: 'me' (Ricardo), 'all' (todos) ou o nome de um familiar.",
    input_schema: schema({
      assignee: { type: "string", description: "'me', 'all' ou nome do familiar. Padrão: 'me'." },
      status: { type: "string", enum: ["open", "done", "cancelled", "all"], description: "Padrão: open" },
    }),
  },
  {
    name: "complete_task",
    description: "Marca uma tarefa como concluída.",
    input_schema: schema({ task_id: { type: "integer" } }, ["task_id"]),
  },
  {
    name: "update_task",
    description: "Altera título, detalhes, prazo ou responsável de uma tarefa. Use cancel=true para cancelar.",
    input_schema: schema(
      {
        task_id: { type: "integer" },
        title: { type: "string" },
        details: { type: "string" },
        due_at: { type: "string", description: DUE_DESC + " Use 'none' para remover o prazo." },
        assignee: { type: "string", description: "Nome do familiar, ou 'me' para o Ricardo." },
        cancel: { type: "boolean" },
      },
      ["task_id"],
    ),
  },
  {
    name: "set_reminder",
    description: "Agenda um lembrete. target: 'me' (Ricardo) ou nome do familiar. Lembretes para familiares seguem a política de autonomia.",
    input_schema: schema(
      {
        message: { type: "string", description: "Texto do lembrete" },
        fire_at: { type: "string", description: "Quando disparar, YYYY-MM-DDTHH:mm local" },
        target: { type: "string", description: "'me' ou nome do familiar. Padrão: 'me'." },
        task_id: { type: "integer", description: "Tarefa relacionada, se houver" },
      },
      ["message", "fire_at"],
    ),
  },
  {
    name: "send_message",
    description:
      "Envia (ou propõe enviar) uma mensagem de WhatsApp para um familiar autorizado. requested_by_owner=true quando o Ricardo pediu explicitamente agora; false quando é iniciativa sua.",
    input_schema: schema(
      {
        contact: { type: "string", description: "Nome do familiar" },
        text: { type: "string", description: "Texto final da mensagem, pronto para enviar" },
        requested_by_owner: { type: "boolean" },
        reason: { type: "string", description: "Por que enviar (uma frase; aparece na proposta)" },
      },
      ["contact", "text", "requested_by_owner"],
    ),
  },
  {
    name: "list_contacts",
    description: "Lista contatos autorizados e seus níveis de autonomia.",
    input_schema: schema({}),
  },
  {
    name: "authorize_contact",
    description:
      "Autoriza um contato a falar com a Aia. Informe pending_id (número desconhecido que já escreveu) OU phone (dígitos com DDI). name é o nome que a Aia usará.",
    input_schema: schema({
      name: { type: "string" },
      phone: { type: "string", description: "Telefone com DDI, só dígitos, ex. 5551999998888" },
      pending_id: { type: "integer", description: "ID do número desconhecido listado no contexto" },
      notes: { type: "string", description: "Relação com o Ricardo e observações (ex.: 'mãe', 'tom carinhoso')" },
    }),
  },
  {
    name: "remove_contact",
    description: "Remove a autorização de um contato (ele passa a ser ignorado).",
    input_schema: schema({ contact: { type: "string" } }, ["contact"]),
  },
  {
    name: "set_autonomy",
    description: `Define o nível de autonomia. contact: nome ou 'all'. action: reply (responder familiar), proactive (iniciativa própria), relay (recado do Ricardo) ou all. level: 0 ${LEVEL_LABEL[0]}, 1 ${LEVEL_LABEL[1]}, 2 ${LEVEL_LABEL[2]}, 3 ${LEVEL_LABEL[3]}.`,
    input_schema: schema(
      {
        contact: { type: "string" },
        action: { type: "string", enum: ["reply", "proactive", "relay", "all"] },
        level: { type: "integer", minimum: 0, maximum: 3 },
      },
      ["contact", "action", "level"],
    ),
  },
  {
    name: "list_pending_proposals",
    description: "Lista propostas de mensagem aguardando aprovação do Ricardo.",
    input_schema: schema({}),
  },
  {
    name: "decide_proposal",
    description: "Aprova, rejeita ou edita e envia uma proposta pendente. Use quando o Ricardo responder a uma proposta em linguagem natural.",
    input_schema: schema(
      {
        proposal_id: { type: "integer" },
        decision: { type: "string", enum: ["approve", "reject", "edit"] },
        new_text: { type: "string", description: "Texto substituto quando decision=edit" },
      },
      ["proposal_id", "decision"],
    ),
  },
  {
    name: "set_paused",
    description: "Pausa (true) ou retoma (false) o atendimento a familiares. Pausada, a Aia só fala com o Ricardo.",
    input_schema: schema({ paused: { type: "boolean" } }, ["paused"]),
  },
];

export const CONTACT_TOOLS: Anthropic.Tool[] = [
  {
    name: "my_tasks",
    description: "Lista as tarefas e lembretes abertos desta pessoa (quem está falando com você).",
    input_schema: schema({}),
  },
  {
    name: "complete_my_task",
    description: "Marca uma tarefa DESTA pessoa como concluída.",
    input_schema: schema({ task_id: { type: "integer" } }, ["task_id"]),
  },
  {
    name: "leave_message_for_ricardo",
    description: "Anota e encaminha um recado desta pessoa para o Ricardo. Use quando ela pedir algo que só ele pode responder.",
    input_schema: schema({ text: { type: "string", description: "Resumo fiel do recado" } }, ["text"]),
  },
];

function resolveContact(ctx: ToolContext, nameOrId: string): Contact | null {
  const v = nameOrId.trim();
  if (!v) return null;
  if (/^(me|eu|ricardo)$/i.test(v)) return ctx.db.getOwner();
  return ctx.db.getContact(v) ?? ctx.db.findContactByName(v);
}

function parseDue(v: unknown): { epoch: number | null; error?: string } {
  const s = str(v).trim();
  if (!s || s.toLowerCase() === "none") return { epoch: null };
  const e = localIsoToEpoch(s);
  if (e === null) return { epoch: null, error: `data inválida: "${s}" (use YYYY-MM-DDTHH:mm)` };
  return { epoch: e };
}

function fmtTask(ctx: ToolContext, t: { id: number; title: string; due_at: number | null; assignee_id: string | null; status: string; details: string | null }): string {
  const who = t.assignee_id ? ctx.db.getContact(t.assignee_id)?.name ?? "?" : config.ownerName;
  return `#${t.id} [${who}] ${t.title}${t.due_at ? ` (prazo ${formatDateTime(t.due_at)})` : ""}${t.details ? ` — ${t.details}` : ""}${t.status !== "open" ? ` [${t.status}]` : ""}`;
}

export async function executeTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<string> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Input;
  const { db, outbox, policy } = ctx;
  try {
    if (ctx.mode === "owner") {
      switch (name) {
        case "add_task": {
          let assignee: Contact | null = null;
          if (str(input.assignee) && !/^(me|eu|ricardo)$/i.test(str(input.assignee))) {
            assignee = resolveContact(ctx, str(input.assignee));
            if (!assignee) return `Erro: não encontrei o contato "${str(input.assignee)}". Contatos: ${db.listContacts("family").map((c) => c.name).join(", ") || "nenhum"}.`;
          }
          const due = parseDue(input.due_at);
          if (due.error) return `Erro: ${due.error}`;
          const t = db.addTask({ title: str(input.title), details: str(input.details) || null, assignee_id: assignee?.id ?? null, due_at: due.epoch, created_by: ctx.speaker.id });
          let extra = "";
          if (input.remind === true && due.epoch) {
            const target = assignee ?? db.getOwner()!;
            const r = db.addReminder({ task_id: t.id, target_id: target.id, message: t.title, fire_at: due.epoch });
            extra = ` Lembrete #${r.id} agendado para ${formatDateTime(due.epoch)}.`;
          }
          db.audit("task_added", t);
          return `Tarefa criada: ${fmtTask(ctx, t)}.${extra}`;
        }
        case "list_tasks": {
          const a = str(input.assignee) || "me";
          const status = (str(input.status) || "open") as "open" | "done" | "cancelled" | "all";
          let assignee_id: string | null | "all";
          if (a === "all") assignee_id = "all";
          else if (/^(me|eu|ricardo)$/i.test(a)) assignee_id = null;
          else {
            const c = resolveContact(ctx, a);
            if (!c) return `Erro: contato "${a}" não encontrado.`;
            assignee_id = c.id;
          }
          const tasks = db.listTasks({ assignee_id, status });
          if (!tasks.length) return "Nenhuma tarefa encontrada.";
          return tasks.map((t) => fmtTask(ctx, t)).join("\n");
        }
        case "complete_task": {
          const t = db.getTask(Number(input.task_id));
          if (!t) return `Erro: tarefa #${str(input.task_id)} não existe.`;
          db.updateTask(t.id, { status: "done", done_at: Date.now() });
          db.audit("task_done", { id: t.id });
          return `Tarefa #${t.id} "${t.title}" concluída.`;
        }
        case "update_task": {
          const t = db.getTask(Number(input.task_id));
          if (!t) return `Erro: tarefa #${str(input.task_id)} não existe.`;
          const patch: Record<string, unknown> = {};
          if (input.cancel === true) patch.status = "cancelled";
          if (str(input.title)) patch.title = str(input.title);
          if (input.details !== undefined) patch.details = str(input.details) || null;
          if (input.due_at !== undefined) {
            const due = parseDue(input.due_at);
            if (due.error) return `Erro: ${due.error}`;
            patch.due_at = due.epoch;
          }
          if (str(input.assignee)) {
            if (/^(me|eu|ricardo)$/i.test(str(input.assignee))) patch.assignee_id = null;
            else {
              const c = resolveContact(ctx, str(input.assignee));
              if (!c) return `Erro: contato "${str(input.assignee)}" não encontrado.`;
              patch.assignee_id = c.id;
            }
          }
          const updated = db.updateTask(t.id, patch as never)!;
          db.audit("task_updated", { id: t.id, patch });
          return `Tarefa atualizada: ${fmtTask(ctx, updated)}`;
        }
        case "set_reminder": {
          const target = resolveContact(ctx, str(input.target) || "me");
          if (!target) return `Erro: contato "${str(input.target)}" não encontrado.`;
          const due = parseDue(input.fire_at);
          if (due.error || !due.epoch) return `Erro: ${due.error ?? "fire_at obrigatório"}`;
          const r = db.addReminder({ task_id: input.task_id ? Number(input.task_id) : null, target_id: target.id, message: str(input.message), fire_at: due.epoch });
          db.audit("reminder_added", r);
          const pol = target.role === "owner" ? "" : ` (para familiar: ${LEVEL_LABEL[policy.level(target, "proactive")]})`;
          return `Lembrete #${r.id} para ${target.name} em ${formatDateTime(due.epoch)}: "${r.message}"${pol}.`;
        }
        case "send_message": {
          const target = resolveContact(ctx, str(input.contact));
          if (!target) return `Erro: contato "${str(input.contact)}" não está autorizado. Autorizados: ${db.listContacts("family").map((c) => c.name).join(", ") || "nenhum"}.`;
          if (target.role === "owner") return "Erro: para falar com o Ricardo, apenas responda nesta conversa.";
          const action: AutonomyAction = input.requested_by_owner === true ? "relay" : "proactive";
          const out = await outbox.request({ target, text: str(input.text), action, reason: str(input.reason) || undefined });
          switch (out.kind) {
            case "sent":
              return `Mensagem enviada para ${target.name}.`;
            case "proposed":
              return `Proposta #${out.proposal.id} criada e enviada ao Ricardo para aprovação (não foi enviada a ${target.name} ainda).`;
            case "forbidden":
              return `Proibido: a política não permite "${ACTION_LABEL[action]}" para ${target.name}.`;
            case "failed":
              return `Falha ao enviar (${out.error}). Provavelmente o WhatsApp Web está desconectado.`;
          }
          return "?";
        }
        case "list_contacts": {
          const cs = db.listContacts("family");
          if (!cs.length) return "Nenhum contato autorizado. Peça ao Ricardo para encaminhar o cartão de contato ou informar o telefone.";
          return cs.map((c) => `${c.name}${c.phone ? " +" + c.phone : ""}${c.notes ? ` (${c.notes})` : ""} · ${policy.describe(c)}`).join("\n");
        }
        case "authorize_contact": {
          const name = str(input.name).trim();
          const notes = str(input.notes) || null;
          if (input.pending_id) {
            const u = db.getUnknown(Number(input.pending_id));
            if (!u) return `Erro: desconhecido #${str(input.pending_id)} não existe.`;
            const c = db.upsertContact({ id: u.wa_id, name: name || u.name || `Contato ${u.id}`, phone: u.phone, role: "family", notes });
            db.setUnknownStatus(u.id, "authorized");
            db.audit("contact_authorized", c);
            return `Contato autorizado: ${c.name}${c.phone ? " +" + c.phone : ""}. ${policy.describe(c)}.`;
          }
          const phone = str(input.phone).replace(/\D/g, "");
          if (!phone || !name) return "Erro: informe name e (phone ou pending_id).";
          const existing = db.findContact(undefined, phone);
          const id = existing?.id ?? `${phone}@c.us`;
          const c = db.upsertContact({ id, name, phone, role: "family", notes });
          db.audit("contact_authorized", c);
          return `Contato autorizado: ${c.name} +${phone}. ${policy.describe(c)}.`;
        }
        case "remove_contact": {
          const c = resolveContact(ctx, str(input.contact));
          if (!c || c.role === "owner") return "Erro: contato não encontrado.";
          db.removeContact(c.id);
          db.audit("contact_removed", c);
          return `Contato ${c.name} removido.`;
        }
        case "set_autonomy": {
          const level = parseLevel(input.level as never);
          if (level === null) return "Erro: level deve ser 0, 1, 2 ou 3.";
          const action = str(input.action) as AutonomyAction | "all";
          const who = str(input.contact);
          if (/^(all|todos|\*)$/i.test(who)) {
            policy.set("*", action, level);
            db.audit("autonomy_set", { contact: "*", action, level });
            return `Autonomia padrão para todos: ${action === "all" ? "todas as ações" : ACTION_LABEL[action]} = ${LEVEL_LABEL[level]}.`;
          }
          const c = resolveContact(ctx, who);
          if (!c || c.role === "owner") return `Erro: contato "${who}" não encontrado.`;
          policy.set(c.id, action, level);
          db.audit("autonomy_set", { contact: c.id, action, level });
          return `Autonomia de ${c.name}: ${policy.describe(c)}.`;
        }
        case "list_pending_proposals": {
          const ps = db.pendingProposals();
          if (!ps.length) return "Nenhuma proposta pendente.";
          return ps.map((p) => `#${p.id} → ${db.getContact(p.target_id)?.name ?? p.target_id} (${ACTION_LABEL[p.action]}): "${p.body}"`).join("\n");
        }
        case "decide_proposal": {
          const p = db.getProposal(Number(input.proposal_id));
          if (!p) return `Erro: proposta #${str(input.proposal_id)} não existe.`;
          if (p.status !== "pending") return `Proposta #${p.id} já está ${p.status}.`;
          const d = str(input.decision);
          if (d === "reject") {
            outbox.reject(p);
            return `Proposta #${p.id} rejeitada.`;
          }
          const r = await outbox.approve(p, d === "edit" ? str(input.new_text) : undefined);
          return r.ok ? `Proposta #${p.id} enviada para ${db.getContact(p.target_id)?.name}.` : `Falha ao enviar a proposta #${p.id}: ${r.error}`;
        }
        case "set_paused": {
          policy.setPaused(input.paused === true);
          db.audit("paused", { paused: input.paused === true });
          return input.paused === true ? "Atendimento a familiares pausado." : "Atendimento a familiares retomado.";
        }
      }
    } else {
      switch (name) {
        case "my_tasks": {
          const tasks = db.listTasks({ assignee_id: ctx.speaker.id });
          const rems = db.pendingReminders(ctx.speaker.id);
          const a = tasks.length ? tasks.map((t) => `#${t.id} ${t.title}${t.due_at ? ` (prazo ${formatDateTime(t.due_at)})` : ""}${t.details ? ` — ${t.details}` : ""}`).join("\n") : "Nenhuma tarefa aberta.";
          const b = rems.length ? rems.map((r) => `- ${formatDateTime(r.fire_at)}: ${r.message}`).join("\n") : "Nenhum lembrete.";
          return `Tarefas:\n${a}\n\nLembretes:\n${b}`;
        }
        case "complete_my_task": {
          const t = db.getTask(Number(input.task_id));
          if (!t || t.assignee_id !== ctx.speaker.id) return "Erro: essa tarefa não é desta pessoa.";
          db.updateTask(t.id, { status: "done", done_at: Date.now() });
          db.audit("task_done_by_contact", { id: t.id, by: ctx.speaker.id });
          void outbox.notifyOwner(`✔️ ${ctx.speaker.name} concluiu a tarefa #${t.id} "${t.title}".`);
          return `Tarefa #${t.id} "${t.title}" marcada como concluída. O Ricardo foi avisado.`;
        }
        case "leave_message_for_ricardo": {
          const text = str(input.text).trim();
          if (!text) return "Erro: recado vazio.";
          db.audit("message_for_owner", { from: ctx.speaker.id, text });
          await outbox.notifyOwner(`💬 Recado de ${ctx.speaker.name}:\n"${text}"`);
          return "Recado encaminhado ao Ricardo.";
        }
      }
    }
    return `Erro: ferramenta desconhecida "${name}".`;
  } catch (e) {
    return `Erro interno na ferramenta ${name}: ${(e as Error).message}`;
  }
}

export function levelOf(v: unknown): Level | null {
  return parseLevel(v as never);
}
