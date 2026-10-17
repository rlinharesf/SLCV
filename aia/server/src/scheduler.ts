import { config } from "./config.js";
import type { Db } from "./db.js";
import { buildDigest } from "./digest.js";
import { log, warn } from "./log.js";
import type { Outbox } from "./outbox.js";
import { localParts } from "./time.js";
import type { ExtensionBridge } from "./ws.js";

const TICK_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private db: Db,
    private outbox: Outbox,
    private bridge: ExtensionBridge,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    if (!this.bridge.connected || !this.bridge.pageState.ready) return;
    if (!this.db.getOwner()) return;
    this.running = true;
    try {
      await this.fireReminders(now);
      await this.expireProposals(now);
      await this.maybeDigest(now);
    } catch (e) {
      warn("scheduler", "erro no tick", e);
    } finally {
      this.running = false;
    }
  }

  private async fireReminders(now: number): Promise<void> {
    for (const r of this.db.dueReminders(now)) {
      const target = this.db.getContact(r.target_id);
      if (!target) {
        this.db.setReminderStatus(r.id, "cancelled");
        continue;
      }
      const task = r.task_id ? this.db.getTask(r.task_id) : null;
      if (task && task.status !== "open") {
        this.db.setReminderStatus(r.id, "cancelled");
        continue;
      }
      const text = target.role === "owner" ? `⏰ Lembrete: ${r.message}` : `Oi, ${target.name}! Lembrete do ${config.ownerName}: ${r.message}`;
      const out = await this.outbox.request({ target, text, action: "proactive", reason: "lembrete agendado", reminderId: r.id });
      if (out.kind === "failed") {
        warn("scheduler", `lembrete #${r.id} falhou (${out.error}); tento de novo no próximo ciclo`);
        continue;
      }
      this.db.setReminderStatus(r.id, out.kind === "forbidden" ? "cancelled" : "sent");
      log("scheduler", `lembrete #${r.id} → ${target.name}: ${out.kind}`);
    }
  }

  private async expireProposals(now: number): Promise<void> {
    const expired = this.db.expiredProposals(now);
    if (!expired.length) return;
    for (const p of expired) {
      this.db.updateProposal(p.id, { status: "expired", decided_at: now });
      if (p.reminder_id) this.db.setReminderStatus(p.reminder_id, "cancelled");
    }
    const list = expired.map((p) => `#${p.id} → ${this.db.getContact(p.target_id)?.name ?? "?"}: "${p.body.slice(0, 60)}"`).join("\n");
    await this.outbox.notifyOwner(`⌛ Propostas expiradas sem resposta (não enviadas):\n${list}`);
  }

  private async maybeDigest(now: number): Promise<void> {
    const p = localParts(new Date(now));
    const [hh, mm] = config.digestTime.split(":").map(Number);
    const minutesNow = p.hour * 60 + p.minute;
    const minutesDigest = hh * 60 + mm;
    // Janela: do horário configurado até 4 horas depois (se o notebook estava desligado, ainda manda).
    if (minutesNow < minutesDigest || minutesNow > minutesDigest + 240) return;
    if (this.db.getSetting("last_digest_date") === p.dateKey) return;
    this.db.setSetting("last_digest_date", p.dateKey);
    const r = await this.outbox.notifyOwner(buildDigest(this.db));
    log("scheduler", `resumo diário enviado: ${r.ok}`);
  }
}
