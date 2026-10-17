import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApproval } from "../src/handlers/approvals.js";
import { parseVcard } from "../src/handlers/vcard.js";
import { localIsoToEpoch, localParts } from "../src/time.js";
import { Db } from "../src/db.js";
import { Policy, parseLevel } from "../src/policy.js";

test("parseApproval reconhece ok/não/edição", () => {
  assert.deepEqual(parseApproval("ok 12"), { kind: "approve", id: 12 });
  assert.deepEqual(parseApproval("OK"), { kind: "approve", id: null });
  assert.deepEqual(parseApproval("pode #7"), { kind: "approve", id: 7 });
  assert.deepEqual(parseApproval("não 3"), { kind: "reject", id: 3 });
  assert.deepEqual(parseApproval("nao"), { kind: "reject", id: null });
  assert.deepEqual(parseApproval("12: Oi mãe, chego às 20h30"), { kind: "edit", id: 12, text: "Oi mãe, chego às 20h30" });
  assert.equal(parseApproval("anota: ligar pro contador"), null);
  assert.equal(parseApproval("o que tenho pendente?"), null);
});

test("parseVcard lê nome e waid", () => {
  const v = "BEGIN:VCARD\nVERSION:3.0\nN:Silva;Maria;;;\nFN:Maria Silva\nTEL;type=CELL;waid=5551999998888:+55 51 99999-8888\nEND:VCARD";
  assert.deepEqual(parseVcard(v), { name: "Maria Silva", phone: "5551999998888" });
  const semWaid = "BEGIN:VCARD\nFN:Pai\nTEL:+55 (51) 98888-7777\nEND:VCARD";
  assert.deepEqual(parseVcard(semWaid), { name: "Pai", phone: "5551988887777" });
});

test("localIsoToEpoch converte hora de Brasília para UTC", () => {
  const e = localIsoToEpoch("2026-10-17T09:00", "America/Sao_Paulo");
  assert.equal(e, Date.UTC(2026, 9, 17, 12, 0));
  const p = localParts(new Date(e!), "America/Sao_Paulo");
  assert.equal(p.hhmm, "09:00");
  assert.equal(localIsoToEpoch("ontem"), null);
});

test("Policy aplica padrões, sobrescritas e papéis", () => {
  const db = new Db(":memory:");
  const policy = new Policy(db);
  const owner = db.upsertContact({ id: "1@c.us", name: "Ricardo", phone: "1", role: "owner", notes: null });
  const mae = db.upsertContact({ id: "2@c.us", name: "Mãe", phone: "2", role: "family", notes: null });
  assert.equal(policy.level(owner, "reply"), 3);
  assert.equal(policy.level(mae, "reply"), 1);
  assert.equal(policy.level(mae, "relay"), 2);
  policy.set("*", "reply", 2);
  assert.equal(policy.level(mae, "reply"), 2);
  policy.set(mae.id, "reply", 3);
  assert.equal(policy.level(mae, "reply"), 3);
  assert.equal(policy.level(null, "reply"), 0);
  assert.equal(parseLevel("talvez"), null);
  assert.equal(parseLevel("silencio"), 3);
  assert.equal(parseLevel(1), 1);
});

test("Db: rebind de ID preserva tarefas e autonomia", () => {
  const db = new Db(":memory:");
  db.upsertContact({ id: "5551@c.us", name: "Mãe", phone: "5551", role: "family", notes: null });
  db.setAutonomy("5551@c.us", "reply", 3);
  const t = db.addTask({ title: "exame", assignee_id: "5551@c.us", created_by: "x" });
  db.rebindContactId("5551@c.us", "999@lid");
  assert.equal(db.getContact("999@lid")?.name, "Mãe");
  assert.equal(db.findContact("5551@c.us", undefined)?.id, "999@lid");
  assert.equal(db.getTask(t.id)?.assignee_id, "999@lid");
  assert.equal(db.getAutonomyOverride("999@lid", "reply"), 3);
});
