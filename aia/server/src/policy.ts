import type { AutonomyAction, Contact, Db, Level } from "./db.js";

/**
 * Níveis de autonomia:
 *  0 = proibido
 *  1 = propõe e espera o "ok" do Ricardo
 *  2 = executa e avisa o Ricardo
 *  3 = executa em silêncio (só registra)
 *
 * Ações:
 *  reply     = responder a um familiar que escreveu para a Aia
 *  proactive = mensagem por iniciativa da Aia (lembrete, cobrança)
 *  relay     = recado que o Ricardo pediu explicitamente para enviar
 */
export const ACTIONS: AutonomyAction[] = ["reply", "proactive", "relay"];

export const DEFAULT_LEVELS: Record<AutonomyAction, Level> = {
  reply: 1,
  proactive: 1,
  relay: 2,
};

export const ACTION_LABEL: Record<AutonomyAction, string> = {
  reply: "responder",
  proactive: "iniciativa própria",
  relay: "recado seu",
};

export const LEVEL_LABEL: Record<Level, string> = {
  0: "proibido",
  1: "pede seu ok",
  2: "envia e avisa",
  3: "envia em silêncio",
};

export class Policy {
  constructor(private db: Db) {}

  /** Nível efetivo para (contato, ação). Dono sempre 3; bloqueado sempre 0. */
  level(contact: Contact | null, action: AutonomyAction): Level {
    if (!contact) return 0;
    if (contact.role === "owner") return 3;
    if (contact.role === "blocked") return 0;
    const specific = this.db.getAutonomyOverride(contact.id, action);
    if (specific !== null) return specific;
    const global = this.db.getAutonomyOverride("*", action);
    if (global !== null) return global;
    return DEFAULT_LEVELS[action];
  }

  set(contactId: string | "*", action: AutonomyAction | "all", level: Level): void {
    const actions = action === "all" ? ACTIONS : [action];
    for (const a of actions) this.db.setAutonomy(contactId, a, level);
  }

  describe(contact: Contact): string {
    return ACTIONS.map((a) => `${ACTION_LABEL[a]}: ${LEVEL_LABEL[this.level(contact, a)]}`).join(" · ");
  }

  isPaused(): boolean {
    return this.db.getSetting("paused") === "1";
  }
  setPaused(p: boolean): void {
    this.db.setSetting("paused", p ? "1" : "0");
  }
}

export function parseLevel(input: string | number): Level | null {
  const n = typeof input === "number" ? input : Number(String(input).trim());
  if ([0, 1, 2, 3].includes(n)) return n as Level;
  const s = String(input).toLowerCase();
  if (/proib|bloque|nunca/.test(s)) return 0;
  if (/pergunt|consult|aprova|ok/.test(s)) return 1;
  if (/avis/.test(s)) return 2;
  if (/silenc|sozinh|livre|direto/.test(s)) return 3;
  return null;
}
