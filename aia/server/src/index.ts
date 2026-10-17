import crypto from "node:crypto";
import { Agent } from "./agent/claude.js";
import { config } from "./config.js";
import { Db } from "./db.js";
import { InboundRouter } from "./handlers/inbound.js";
import { log, warn } from "./log.js";
import { Outbox } from "./outbox.js";
import { Policy } from "./policy.js";
import { Scheduler } from "./scheduler.js";
import { formatDateTime } from "./time.js";
import { ExtensionBridge, attachStatusRoutes, createHttpServer } from "./ws.js";

process.on("unhandledRejection", (e) => warn("main", "unhandledRejection", e));
process.on("uncaughtException", (e) => warn("main", "uncaughtException", e));

const db = new Db();
const policy = new Policy(db);
const server = createHttpServer();
const bridge = new ExtensionBridge(server);
const outbox = new Outbox(db, bridge, policy);
const agent = new Agent(db, outbox, policy);
const router = new InboundRouter(db, bridge, outbox, policy, agent);
const scheduler = new Scheduler(db, outbox, bridge);

function ensurePairingCode(): string | null {
  if (db.getOwner()) return null;
  let code = db.getSetting("pairing_code");
  if (!code) {
    code = String(crypto.randomInt(100000, 999999));
    db.setSetting("pairing_code", code);
  }
  return code;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

bridge.statusJson = () => ({
  extensionConnected: bridge.connected,
  whatsappReady: bridge.pageState.ready,
  account: bridge.pageState.me,
  ownerPaired: !!db.getOwner(),
  pairingCode: ensurePairingCode(),
  apiKeyConfigured: !!config.apiKey,
  model: config.model,
  paused: policy.isPaused(),
  contacts: db.listContacts("family").map((c) => ({ name: c.name, phone: c.phone, id: c.id })),
  openTasks: db.listTasks({ assignee_id: "all" }).length,
  pendingProposals: db.pendingProposals().length,
  pendingReminders: db.pendingReminders().length,
  unknownSenders: db.pendingUnknown().length,
  messagesStored: db.countMessages(),
  lastExtensionSeen: bridge.lastSeen ? new Date(bridge.lastSeen).toISOString() : null,
});

bridge.statusHtml = () => {
  const s = bridge.statusJson();
  const dot = (ok: boolean) => `<span style="color:${ok ? "#27ae60" : "#c0392b"}">●</span>`;
  const audit = db
    .recentAudit(25)
    .map((a) => `<tr><td>${esc(formatDateTime(a.ts))}</td><td>${esc(a.kind)}</td><td><code>${esc(a.payload.slice(0, 200))}</code></td></tr>`)
    .join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>Aia · status</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#222}h1{font-size:22px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left;vertical-align:top}code{font-size:12px}.big{font-size:28px;letter-spacing:4px;font-weight:700}</style></head><body>
<h1>Aia · painel local</h1>
<p>${dot(!!s.extensionConnected)} Extensão do Chrome: <b>${s.extensionConnected ? "conectada" : "desconectada"}</b><br>
${dot(!!s.whatsappReady)} WhatsApp Web: <b>${s.whatsappReady ? "pronto" : "não pronto"}</b> ${s.account ? `(conta ${esc(s.account)})` : ""}<br>
${dot(!!s.apiKeyConfigured)} Chave da API: <b>${s.apiKeyConfigured ? "configurada" : "FALTANDO no .env"}</b> · modelo ${esc(s.model)}<br>
${dot(!!s.ownerPaired)} Dono pareado: <b>${s.ownerPaired ? "sim" : "não"}</b> · ${s.paused ? "⏸ pausada" : "▶ ativa"}</p>
${s.pairingCode ? `<p><b>Para parear:</b> do seu WhatsApp pessoal, mande para a Aia a mensagem <span class="big">pareia ${esc(s.pairingCode)}</span></p>` : ""}
<p>Contatos autorizados: ${(s.contacts as { name: string }[]).map((c) => esc(c.name)).join(", ") || "nenhum"}<br>
Tarefas abertas: ${s.openTasks} · Propostas pendentes: ${s.pendingProposals} · Lembretes: ${s.pendingReminders} · Desconhecidos: ${s.unknownSenders} · Mensagens guardadas: ${s.messagesStored}</p>
<h2 style="font-size:16px">Últimos eventos</h2><table><tr><th>quando</th><th>tipo</th><th>dados</th></tr>${audit}</table>
<p style="color:#777;font-size:12px">Atualiza a cada 15 s · JSON em <a href="/health">/health</a></p></body></html>`;
};

attachStatusRoutes(server, bridge);
bridge.on("message", (m) => router.enqueue(m));
bridge.on("ready", () => void scheduler.tick());

server.listen(config.port, "127.0.0.1", () => {
  log("main", `Aia servidor em http://127.0.0.1:${config.port}/  (extensão: ws://127.0.0.1:${config.port}/ext)`);
  log("main", `modelo ${config.model} · esforço ${config.effort} · fuso ${config.timezone} · resumo às ${config.digestTime}`);
  const code = ensurePairingCode();
  if (code) log("main", `>>> Dono ainda não pareado. Do seu WhatsApp pessoal, mande para a Aia: "pareia ${code}"`);
  if (!config.apiKey) warn("main", ">>> ANTHROPIC_API_KEY ausente. Copie .env.example para .env e preencha.");
  scheduler.start();
});
