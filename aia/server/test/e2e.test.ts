import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { Agent } from "../src/agent/claude.js";
import { Db } from "../src/db.js";
import { InboundRouter } from "../src/handlers/inbound.js";
import { Outbox } from "../src/outbox.js";
import { Policy } from "../src/policy.js";
import { Scheduler } from "../src/scheduler.js";
import { ExtensionBridge, type InboundMessage } from "../src/ws.js";

/** Extensão falsa: responde aos comandos "send" e registra o que foi enviado. */
class FakeExtension {
  ws!: WebSocket;
  sent: { to: string; text: string }[] = [];
  private n = 0;
  async connect(port: number): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.ws.on("message", (raw) => {
      const d = JSON.parse(String(raw));
      if (d.type === "cmd") {
        const cmd = d.cmd;
        if (cmd.op === "send") {
          this.sent.push({ to: cmd.to, text: cmd.text });
          this.ws.send(JSON.stringify({ type: "result", reqId: cmd.reqId, ok: true, msgId: `out-${++this.n}` }));
        } else {
          this.ws.send(JSON.stringify({ type: "result", reqId: cmd.reqId, ok: true }));
        }
      }
    });
    this.ws.send(JSON.stringify({ type: "hello", pageState: { ready: true, me: "aia@c.us" } }));
    this.ws.send(JSON.stringify({ type: "ready", state: { ready: true, me: "aia@c.us" } }));
  }
  inbound(partial: Partial<InboundMessage> & { from: string; body: string }): void {
    const m: InboundMessage = {
      id: `in-${Date.now()}-${Math.random()}`,
      fromMe: false,
      chatId: partial.from,
      isGroup: false,
      type: "chat",
      vcards: [],
      ...partial,
    };
    this.ws.send(JSON.stringify({ type: "message", message: m }));
  }
  async waitSent(count: number, timeoutMs = 4000): Promise<void> {
    const start = Date.now();
    while (this.sent.length < count) {
      if (Date.now() - start > timeoutMs) throw new Error(`esperava ${count} envios, tenho ${this.sent.length}: ${JSON.stringify(this.sent)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  close(): void {
    this.ws.close();
  }
}

test("fluxo ponta a ponta sem LLM: pareamento, desconhecido, autorização, lembrete, proposta, aprovação", async () => {
  const db = new Db(":memory:");
  const policy = new Policy(db);
  const server = http.createServer();
  const bridge = new ExtensionBridge(server);
  const outbox = new Outbox(db, bridge, policy);
  const agent = new Agent(db, outbox, policy); // sem chave: comandos fixos continuam funcionando
  const router = new InboundRouter(db, bridge, outbox, policy, agent);
  const scheduler = new Scheduler(db, outbox, bridge);
  bridge.on("message", (m) => router.enqueue(m));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  db.setSetting("pairing_code", "123456");

  const ext = new FakeExtension();
  await ext.connect(port);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bridge.connected, true);
  assert.equal(bridge.pageState.ready, true);

  // 1) Mensagem de desconhecido antes do pareamento: nada acontece
  ext.inbound({ from: "mae@lid", body: "Oi, é a mãe", notifyName: "Mãe", senderPhone: "5551999998888" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ext.sent.length, 0);

  // 2) Pareamento do dono
  ext.inbound({ from: "ricardo@c.us", body: "pareia 123456", senderPhone: "5551911112222" });
  await ext.waitSent(1);
  assert.equal(ext.sent[0].to, "ricardo@c.us");
  assert.match(ext.sent[0].text, /Estou ativa/);
  assert.equal(db.getOwner()?.id, "ricardo@c.us");

  // 3) Comando fixo
  ext.inbound({ from: "ricardo@c.us", body: "status" });
  await ext.waitSent(2);
  assert.match(ext.sent[1].text, /Estado: ativa/);

  // 4) Desconhecido escreve de novo: dono é avisado uma vez
  ext.inbound({ from: "mae@lid", body: "Filho?", notifyName: "Mãe", senderPhone: "5551999998888" });
  await ext.waitSent(3);
  assert.match(ext.sent[2].text, /Número desconhecido #1/);
  ext.inbound({ from: "mae@lid", body: "Tá aí?", notifyName: "Mãe" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ext.sent.length, 3, "não deve avisar de novo dentro do intervalo");

  // 5) Autorização pelo número do aviso
  ext.inbound({ from: "ricardo@c.us", body: "autoriza 1 Mãe" });
  await ext.waitSent(4);
  assert.match(ext.sent[3].text, /Mãe autorizado/);
  const mae = db.getContact("mae@lid");
  assert.equal(mae?.role, "family");
  assert.equal(mae?.phone, "5551999998888");

  // 6) Lembrete vencido para a mãe: política nível 1 => vira proposta para o dono
  db.addReminder({ target_id: "mae@lid", message: "exame às 10h", fire_at: Date.now() - 1000 });
  await scheduler.tick();
  await ext.waitSent(5);
  assert.match(ext.sent[4].text, /Proposta #1 → Mãe/);
  assert.equal(db.pendingProposals().length, 1);
  assert.equal(ext.sent.filter((s) => s.to === "mae@lid").length, 0, "nada foi para a mãe ainda");

  // 7) Dono edita e aprova: "1: texto"
  ext.inbound({ from: "ricardo@c.us", body: "1: Oi mãe, lembrete do exame às 10h. Beijo!" });
  await ext.waitSent(7);
  const toMae = ext.sent.find((s) => s.to === "mae@lid");
  assert.ok(toMae);
  assert.equal(toMae!.text, "Oi mãe, lembrete do exame às 10h. Beijo!");
  assert.equal(db.getProposal(1)?.status, "sent");
  assert.match(ext.sent[ext.sent.length - 1].text, /Enviei para Mãe/);

  // 8) Reply quoting the proposal with "não": rejeita
  db.addReminder({ target_id: "mae@lid", message: "remédio", fire_at: Date.now() - 1000 });
  await scheduler.tick();
  await ext.waitSent(8);
  const p2 = db.pendingProposals()[0];
  assert.ok(p2.notify_msg_id);
  ext.inbound({ from: "ricardo@c.us", body: "não", quotedMsgId: p2.notify_msg_id! });
  await ext.waitSent(9);
  assert.equal(db.getProposal(p2.id)?.status, "rejected");
  assert.match(ext.sent[8].text, /cancelada/);

  // 9) Pausa: familiar autorizado é ignorado
  ext.inbound({ from: "ricardo@c.us", body: "pausa" });
  await ext.waitSent(10);
  assert.equal(policy.isPaused(), true);
  ext.inbound({ from: "mae@lid", body: "oi" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ext.sent.length, 10);

  // 10) Sem chave da API, mensagem livre do dono recebe aviso
  ext.inbound({ from: "ricardo@c.us", body: "anota: comprar pão" });
  await ext.waitSent(11);
  assert.match(ext.sent[10].text, /chave da API/);

  ext.close();
  server.close();
  await new Promise((r) => setTimeout(r, 50));
});
