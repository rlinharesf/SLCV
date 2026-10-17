import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type Role = "owner" | "family" | "blocked";
export type AutonomyAction = "reply" | "proactive" | "relay";
export type Level = 0 | 1 | 2 | 3;

export interface Contact {
  id: string; // ID do WhatsApp como aparece nas mensagens (xxx@c.us ou xxx@lid)
  name: string;
  phone: string | null; // só dígitos
  alt_ids: string; // JSON string[]
  role: Role;
  notes: string | null;
  created_at: number;
}

export interface Task {
  id: number;
  title: string;
  details: string | null;
  assignee_id: string | null; // null = Ricardo
  due_at: number | null;
  status: "open" | "done" | "cancelled";
  created_by: string;
  created_at: number;
  done_at: number | null;
}

export interface Reminder {
  id: number;
  task_id: number | null;
  target_id: string; // contato alvo (owner ou familiar)
  message: string;
  fire_at: number;
  status: "pending" | "sent" | "cancelled";
  created_at: number;
}

export interface Proposal {
  id: number;
  target_id: string;
  action: AutonomyAction;
  body: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "sent" | "failed";
  notify_msg_id: string | null;
  created_at: number;
  decided_at: number | null;
  expires_at: number;
  reminder_id: number | null;
}

export interface StoredMessage {
  id: number;
  wa_id: string | null;
  chat_id: string;
  contact_id: string | null;
  direction: "in" | "out";
  body: string;
  type: string;
  ts: number;
}

export interface UnknownSender {
  id: number;
  wa_id: string;
  phone: string | null;
  name: string | null;
  last_body: string | null;
  first_seen: number;
  last_seen: number;
  last_notified: number | null;
  status: "pending" | "authorized" | "ignored";
}

export class Db {
  readonly db: DatabaseSync;

  constructor(filePath = config.dbPath) {
    if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, alt_ids TEXT NOT NULL DEFAULT '[]',
        role TEXT NOT NULL, notes TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy (
        contact_id TEXT NOT NULL, action TEXT NOT NULL, level INTEGER NOT NULL,
        PRIMARY KEY (contact_id, action)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, details TEXT, assignee_id TEXT,
        due_at INTEGER, status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, done_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, target_id TEXT NOT NULL, message TEXT NOT NULL,
        fire_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, action TEXT NOT NULL, body TEXT NOT NULL,
        reason TEXT, status TEXT NOT NULL DEFAULT 'pending', notify_msg_id TEXT, created_at INTEGER NOT NULL,
        decided_at INTEGER, expires_at INTEGER NOT NULL, reminder_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT, chat_id TEXT NOT NULL, contact_id TEXT,
        direction TEXT NOT NULL, body TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'chat', ts INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_id ON messages(wa_id) WHERE wa_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, ts);
      CREATE TABLE IF NOT EXISTS unknown_senders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT UNIQUE NOT NULL, phone TEXT, name TEXT, last_body TEXT,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, last_notified INTEGER, status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
      );
    `);
  }

  // ---------- settings ----------
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }
  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ---------- audit ----------
  audit(kind: string, payload: unknown): void {
    this.db.prepare("INSERT INTO audit(ts, kind, payload) VALUES(?, ?, ?)").run(Date.now(), kind, JSON.stringify(payload));
  }
  recentAudit(limit = 30): { ts: number; kind: string; payload: string }[] {
    return this.db.prepare("SELECT ts, kind, payload FROM audit ORDER BY id DESC LIMIT ?").all(limit) as never;
  }

  // ---------- contacts ----------
  getContact(id: string): Contact | null {
    return (this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Contact | undefined) ?? null;
  }
  getOwner(): Contact | null {
    return (this.db.prepare("SELECT * FROM contacts WHERE role = 'owner' LIMIT 1").get() as Contact | undefined) ?? null;
  }
  listContacts(role?: Role): Contact[] {
    if (role) return this.db.prepare("SELECT * FROM contacts WHERE role = ? ORDER BY name").all(role) as never;
    return this.db.prepare("SELECT * FROM contacts ORDER BY role, name").all() as never;
  }
  /** Procura contato pelo ID exato, por ID alternativo ou pelo telefone. */
  findContact(waId: string | undefined, phone: string | undefined): Contact | null {
    if (waId) {
      const c = this.getContact(waId);
      if (c) return c;
      const alt = this.db
        .prepare("SELECT * FROM contacts WHERE alt_ids LIKE ?")
        .all(`%${JSON.stringify(waId)}%`) as unknown as Contact[];
      if (alt.length) return alt[0];
    }
    if (phone) {
      const byPhone = this.db.prepare("SELECT * FROM contacts WHERE phone = ?").get(phone) as Contact | undefined;
      if (byPhone) return byPhone;
    }
    return null;
  }
  findContactByName(name: string): Contact | null {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const exact = this.db.prepare("SELECT * FROM contacts WHERE lower(name) = ?").get(n) as Contact | undefined;
    if (exact) return exact;
    const partial = this.db.prepare("SELECT * FROM contacts WHERE lower(name) LIKE ? ORDER BY length(name)").all(`%${n}%`) as unknown as Contact[];
    return partial.length === 1 ? partial[0] : partial[0] ?? null;
  }
  upsertContact(c: Omit<Contact, "created_at" | "alt_ids"> & { alt_ids?: string[] }): Contact {
    const existing = this.getContact(c.id);
    const altIds = JSON.stringify(c.alt_ids ?? (existing ? (JSON.parse(existing.alt_ids) as string[]) : []));
    this.db
      .prepare(
        `INSERT INTO contacts(id, name, phone, alt_ids, role, notes, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, phone = COALESCE(excluded.phone, contacts.phone),
         alt_ids = excluded.alt_ids, role = excluded.role, notes = COALESCE(excluded.notes, contacts.notes)`,
      )
      .run(c.id, c.name, c.phone, altIds, c.role, c.notes ?? null, existing?.created_at ?? Date.now());
    return this.getContact(c.id)!;
  }
  addAltId(contactId: string, altId: string): void {
    const c = this.getContact(contactId);
    if (!c) return;
    const ids = new Set(JSON.parse(c.alt_ids) as string[]);
    ids.add(altId);
    this.db.prepare("UPDATE contacts SET alt_ids = ? WHERE id = ?").run(JSON.stringify([...ids]), contactId);
  }
  /** Troca o ID principal de um contato (ex.: autorizado por telefone, escreveu com @lid). */
  rebindContactId(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const c = this.getContact(oldId);
    if (!c) return;
    const ids = new Set(JSON.parse(c.alt_ids) as string[]);
    ids.add(oldId);
    ids.delete(newId);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE contacts SET id = ?, alt_ids = ? WHERE id = ?").run(newId, JSON.stringify([...ids]), oldId);
      this.db.prepare("UPDATE OR REPLACE autonomy SET contact_id = ? WHERE contact_id = ?").run(newId, oldId);
      this.db.prepare("UPDATE tasks SET assignee_id = ? WHERE assignee_id = ?").run(newId, oldId);
      this.db.prepare("UPDATE reminders SET target_id = ? WHERE target_id = ?").run(newId, oldId);
      this.db.prepare("UPDATE proposals SET target_id = ? WHERE target_id = ?").run(newId, oldId);
      this.db.prepare("UPDATE messages SET contact_id = ? WHERE contact_id = ?").run(newId, oldId);
      this.db.prepare("UPDATE messages SET chat_id = ? WHERE chat_id = ?").run(newId, oldId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  removeContact(id: string): void {
    this.db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM autonomy WHERE contact_id = ?").run(id);
  }

  // ---------- autonomy ----------
  getAutonomyOverride(contactId: string, action: AutonomyAction): Level | null {
    const row = this.db.prepare("SELECT level FROM autonomy WHERE contact_id = ? AND action = ?").get(contactId, action) as
      | { level: number }
      | undefined;
    return row ? (row.level as Level) : null;
  }
  setAutonomy(contactId: string, action: AutonomyAction, level: Level): void {
    this.db
      .prepare(
        "INSERT INTO autonomy(contact_id, action, level) VALUES(?, ?, ?) ON CONFLICT(contact_id, action) DO UPDATE SET level = excluded.level",
      )
      .run(contactId, action, level);
  }
  listAutonomy(): { contact_id: string; action: AutonomyAction; level: Level }[] {
    return this.db.prepare("SELECT * FROM autonomy").all() as never;
  }

  // ---------- tasks ----------
  addTask(t: { title: string; details?: string | null; assignee_id?: string | null; due_at?: number | null; created_by: string }): Task {
    const r = this.db
      .prepare("INSERT INTO tasks(title, details, assignee_id, due_at, status, created_by, created_at) VALUES(?, ?, ?, ?, 'open', ?, ?)")
      .run(t.title, t.details ?? null, t.assignee_id ?? null, t.due_at ?? null, t.created_by, Date.now());
    return this.getTask(Number(r.lastInsertRowid))!;
  }
  getTask(id: number): Task | null {
    return (this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined) ?? null;
  }
  listTasks(opts: { assignee_id?: string | null | "all"; status?: Task["status"] | "all" } = {}): Task[] {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (opts.assignee_id !== "all") {
      if (opts.assignee_id === null || opts.assignee_id === undefined) where.push("assignee_id IS NULL");
      else {
        where.push("assignee_id = ?");
        params.push(opts.assignee_id);
      }
    }
    const status = opts.status ?? "open";
    if (status !== "all") {
      where.push("status = ?");
      params.push(status);
    }
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY (due_at IS NULL), due_at, id`;
    return this.db.prepare(sql).all(...params) as never;
  }
  updateTask(id: number, patch: Partial<Pick<Task, "title" | "details" | "assignee_id" | "due_at" | "status" | "done_at">>): Task | null {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return this.getTask(id);
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => patch[k] as string | number | null);
    this.db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...vals, id);
    return this.getTask(id);
  }

  // ---------- reminders ----------
  addReminder(r: { task_id?: number | null; target_id: string; message: string; fire_at: number }): Reminder {
    const res = this.db
      .prepare("INSERT INTO reminders(task_id, target_id, message, fire_at, status, created_at) VALUES(?, ?, ?, ?, 'pending', ?)")
      .run(r.task_id ?? null, r.target_id, r.message, r.fire_at, Date.now());
    return this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(Number(res.lastInsertRowid)) as unknown as Reminder;
  }
  dueReminders(now = Date.now()): Reminder[] {
    return this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at").all(now) as never;
  }
  pendingReminders(targetId?: string): Reminder[] {
    if (targetId)
      return this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND target_id = ? ORDER BY fire_at").all(targetId) as never;
    return this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' ORDER BY fire_at").all() as never;
  }
  setReminderStatus(id: number, status: Reminder["status"]): void {
    this.db.prepare("UPDATE reminders SET status = ? WHERE id = ?").run(status, id);
  }

  // ---------- proposals ----------
  addProposal(p: { target_id: string; action: AutonomyAction; body: string; reason?: string | null; expires_at: number; reminder_id?: number | null }): Proposal {
    const res = this.db
      .prepare(
        "INSERT INTO proposals(target_id, action, body, reason, status, created_at, expires_at, reminder_id) VALUES(?, ?, ?, ?, 'pending', ?, ?, ?)",
      )
      .run(p.target_id, p.action, p.body, p.reason ?? null, Date.now(), p.expires_at, p.reminder_id ?? null);
    return this.getProposal(Number(res.lastInsertRowid))!;
  }
  getProposal(id: number): Proposal | null {
    return (this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Proposal | undefined) ?? null;
  }
  pendingProposals(): Proposal[] {
    return this.db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id").all() as never;
  }
  latestPendingProposal(): Proposal | null {
    return (this.db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id DESC LIMIT 1").get() as Proposal | undefined) ?? null;
  }
  proposalByNotifyMsg(msgId: string): Proposal | null {
    return (this.db.prepare("SELECT * FROM proposals WHERE notify_msg_id = ?").get(msgId) as Proposal | undefined) ?? null;
  }
  updateProposal(id: number, patch: Partial<Pick<Proposal, "status" | "body" | "notify_msg_id" | "decided_at">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE proposals SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as string | number | null), id);
  }
  expiredProposals(now = Date.now()): Proposal[] {
    return this.db.prepare("SELECT * FROM proposals WHERE status = 'pending' AND expires_at <= ?").all(now) as never;
  }

  // ---------- messages ----------
  saveMessage(m: { wa_id?: string | null; chat_id: string; contact_id?: string | null; direction: "in" | "out"; body: string; type?: string; ts?: number }): boolean {
    try {
      this.db
        .prepare("INSERT INTO messages(wa_id, chat_id, contact_id, direction, body, type, ts) VALUES(?, ?, ?, ?, ?, ?, ?)")
        .run(m.wa_id ?? null, m.chat_id, m.contact_id ?? null, m.direction, m.body, m.type ?? "chat", m.ts ?? Date.now());
      return true;
    } catch (e) {
      // UNIQUE (mensagem repetida pela extensão)
      return false;
    }
  }
  hasMessage(waId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM messages WHERE wa_id = ?").get(waId);
  }
  recentMessages(chatId: string, limit = 30): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT ?")
      .all(chatId, limit) as unknown as StoredMessage[];
    return rows.reverse();
  }
  lastInbound(contactId: string): StoredMessage | null {
    return (
      (this.db
        .prepare("SELECT * FROM messages WHERE contact_id = ? AND direction = 'in' ORDER BY ts DESC LIMIT 1")
        .get(contactId) as StoredMessage | undefined) ?? null
    );
  }
  countMessages(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  }

  // ---------- unknown senders ----------
  touchUnknown(u: { wa_id: string; phone?: string | null; name?: string | null; body?: string | null }): UnknownSender {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO unknown_senders(wa_id, phone, name, last_body, first_seen, last_seen, status) VALUES(?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(wa_id) DO UPDATE SET phone = COALESCE(excluded.phone, unknown_senders.phone),
         name = COALESCE(excluded.name, unknown_senders.name), last_body = excluded.last_body, last_seen = excluded.last_seen`,
      )
      .run(u.wa_id, u.phone ?? null, u.name ?? null, u.body ?? null, now, now);
    return this.db.prepare("SELECT * FROM unknown_senders WHERE wa_id = ?").get(u.wa_id) as unknown as UnknownSender;
  }
  getUnknown(id: number): UnknownSender | null {
    return (this.db.prepare("SELECT * FROM unknown_senders WHERE id = ?").get(id) as UnknownSender | undefined) ?? null;
  }
  markUnknownNotified(id: number): void {
    this.db.prepare("UPDATE unknown_senders SET last_notified = ? WHERE id = ?").run(Date.now(), id);
  }
  setUnknownStatus(id: number, status: UnknownSender["status"]): void {
    this.db.prepare("UPDATE unknown_senders SET status = ? WHERE id = ?").run(status, id);
  }
  pendingUnknown(): UnknownSender[] {
    return this.db.prepare("SELECT * FROM unknown_senders WHERE status = 'pending' ORDER BY last_seen DESC").all() as never;
  }
}
