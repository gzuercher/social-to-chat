import { pino } from "pino";

/**
 * Zentraler Logger. `webhookUrl` und Tokens werden redaktiert, damit keine
 * Secrets im Log landen (das Repo ist Open Source).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["webhookUrl", "*.webhookUrl", "token", "*.token", "accessToken", "*.accessToken"],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
