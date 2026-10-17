import { config } from "./config.js";

const TZ = () => config.timezone;

/** Partes de data/hora locais (no fuso configurado) de um instante. */
export function localParts(date: Date = new Date(), tz = TZ()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`,
  };
}

/** Deslocamento (ms) do fuso em relação ao UTC num dado instante. */
function tzOffsetMs(date: Date, tz = TZ()): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converte "YYYY-MM-DDTHH:mm" (hora local do fuso) em epoch ms UTC. */
export function localIsoToEpoch(localIso: string, tz = TZ()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(localIso.trim());
  if (!m) return null;
  const [, y, mo, d, h = "09", mi = "00", s = "00"] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Duas iterações bastam para convergir mesmo perto de mudanças de horário.
  let epoch = guess - tzOffsetMs(new Date(guess), tz);
  epoch = guess - tzOffsetMs(new Date(epoch), tz);
  return epoch;
}

export function formatDateTime(epochMs: number, tz = TZ()): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochMs));
}

export function formatDate(epochMs: number, tz = TZ()): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit" }).format(
    new Date(epochMs),
  );
}

export function nowLocalDescription(tz = TZ()): string {
  const d = new Date();
  const full = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  const p = localParts(d, tz);
  const iso = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return `${full} (ISO local: ${iso}, fuso ${tz})`;
}
