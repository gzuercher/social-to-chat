import { LAST_RUN_METADATA_KEY, Store } from "../state/store.js";

const DEFAULT_MAX_AGE_SECONDS = 15 * 60;

/**
 * Subcommand: docker HEALTHCHECK (gespiegelt von status-page-to-chat).
 *
 * Healthy, wenn der SQLite-Store aufgeht und der letzte abgeschlossene
 * Poll-Lauf jünger als HEALTH_MAX_AGE_SECONDS (Default 15 min) ist.
 * Erkennt den Fall „Prozess lebt, aber Poll-Loop hängt", den reine
 * Container-Liveness-Checks übersehen.
 *
 * Liest bewusst nur STATE_DB_PATH (nicht die volle Config) — der
 * Healthcheck darf nicht an fehlendem WEBHOOK_URL scheitern.
 *
 * Exit 0 (healthy) oder 1 (unhealthy); eine Statuszeile auf stdout,
 * damit `docker inspect` Kontext zeigt.
 */
export function runHealthcheck(): void {
  const maxAgeSeconds = Number(process.env.HEALTH_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);
  const dbPath = process.env.STATE_DB_PATH ?? "./data/social-to-chat.db";

  let store: Store;
  try {
    store = new Store(dbPath);
  } catch (err) {
    process.stdout.write(`unhealthy: cannot open state store: ${(err as Error).message}\n`);
    process.exit(1);
  }

  try {
    const lastRunAt = store.getMeta(LAST_RUN_METADATA_KEY);
    if (!lastRunAt) {
      // Noch kein Lauf abgeschlossen: während des Startfensters healthy —
      // start_period des HEALTHCHECK deckt das ab.
      process.stdout.write("healthy: no poll completed yet (warming up)\n");
      process.exit(0);
    }

    const ageMs = Date.now() - new Date(lastRunAt).getTime();
    const ageSeconds = Math.floor(ageMs / 1000);

    if (Number.isNaN(ageMs) || ageSeconds > maxAgeSeconds) {
      process.stdout.write(`unhealthy: last poll was ${ageSeconds}s ago (max ${maxAgeSeconds}s)\n`);
      process.exit(1);
    }

    process.stdout.write(`healthy: last poll was ${ageSeconds}s ago\n`);
    process.exit(0);
  } finally {
    store.close();
  }
}
