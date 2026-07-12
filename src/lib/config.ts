import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Konfiguration: nicht-geheime Struktur (welche Seiten pollen, wie oft) aus
 * einer YAML-Datei, Secrets (Tokens, Webhook-URL) aus Umgebungsvariablen.
 *
 * Secrets NIE in die YAML schreiben — das Repo ist Open Source. In der YAML
 * stehen `${ENV_NAME}`-Platzhalter, die hier aus process.env aufgelöst werden.
 */

const platformSchema = z.object({
  /** Eindeutiger Key, auch für die Deduplizierung/State genutzt. */
  key: z.string().min(1),
  platform: z.enum(["linkedin", "facebook", "instagram", "tiktok"]),
  /** Menschlicher Name der Seite/Organisation (fürs Log). */
  name: z.string().default(""),
  /** Ob dieser Adapter aktiv gepollt wird. */
  enabled: z.boolean().default(true),
  /** Adapter-spezifische Felder (Org-ID, Page-ID, Token-ENV-Name …). */
  options: z.record(z.string(), z.unknown()).default({}),
});

const configSchema = z.object({
  /** Cron-Ausdruck fürs Polling (croner-Syntax). Default: alle 5 Minuten. */
  schedule: z.string().default("*/5 * * * *"),
  /** Ziel-Webhook (social-feed Logic App). Aus ENV WEBHOOK_URL, nicht aus YAML. */
  webhookUrl: z.string().url(),
  /** Pfad zur SQLite-Datei für State/Dedup. */
  dbPath: z.string().default("./data/social-to-chat.db"),
  platforms: z.array(platformSchema).default([]),
});

export type PlatformConfig = z.infer<typeof platformSchema>;
export type Config = z.infer<typeof configSchema>;

/** Ersetzt `${ENV}`-Platzhalter rekursiv durch process.env-Werte. */
function resolveEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`Config referenziert unbekannte ENV-Variable: ${name}`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(resolveEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v)]));
  }
  return value;
}

export function loadConfig(path = process.env.CONFIG_PATH ?? "./config/platforms.yaml"): Config {
  const raw = resolveEnv(parseYaml(readFileSync(path, "utf8")) ?? {});
  const merged = {
    ...(raw as Record<string, unknown>),
    webhookUrl: process.env.WEBHOOK_URL ?? (raw as Record<string, unknown>).webhookUrl,
  };
  return configSchema.parse(merged);
}
