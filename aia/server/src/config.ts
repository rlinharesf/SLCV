import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/src/config.js -> raiz do servidor
export const SERVER_ROOT = path.resolve(here, "..", "..");
dotenv.config({ path: path.join(SERVER_ROOT, ".env") });

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: env("AIA_MODEL", "claude-opus-5-5"),
  effort: env("AIA_EFFORT", "medium") as "low" | "medium" | "high" | "xhigh" | "max",
  ownerPhone: env("OWNER_PHONE", "").replace(/\D/g, ""),
  port: Number(env("PORT", "8787")),
  timezone: env("TIMEZONE", "America/Sao_Paulo"),
  digestTime: env("DIGEST_TIME", "17:00"),
  proposalTtlHours: Number(env("PROPOSAL_TTL_HOURS", "6")),
  ackEnabled: env("ACK_ENABLED", "false").toLowerCase() === "true",
  dbPath: path.resolve(SERVER_ROOT, env("DB_PATH", "./data/aia.sqlite")),
  assistantName: "Aia",
  ownerName: "Ricardo",
};
