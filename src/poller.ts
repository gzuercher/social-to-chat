import type { PlatformConfig } from "./lib/config.js";
import { logger, type Logger } from "./lib/logger.js";
import { categorizeError } from "./lib/errorCategory.js";
import {
  formatDuration,
  HealthTracker,
  type HealthEvent,
  type PollResult as HealthPollResult,
} from "./lib/healthTracker.js";
import { checkTokenExpiry } from "./lib/tokenWatchdog.js";
import { ensureFreshTokens, hasRefreshConfig } from "./lib/tokenRefresh.js";
import { LAST_RUN_METADATA_KEY, Store } from "./state/store.js";
import { createProvider } from "./platforms/index.js";
import type { Notifier, OpsEvent, SocialEvent, SocialProvider } from "./platforms/types.js";

/**
 * Poll-Orchestrierung (Muster gespiegelt von status-page-to-chat):
 *
 *   • Ein Lauf pollt alle aktiven Provider parallel, dedupt gegen den Store
 *     und verschickt nur wirklich Neues. Fehlgeschlagene Sendungen werden
 *     nicht als gesehen markiert → nächster Lauf versucht es erneut.
 *   • Erstlauf pro Provider: Bestand wird still eingelesen (kein Flood).
 *   • HealthTracker + Token-Watchdog melden Betriebsprobleme als Ops-Events
 *     durch denselben Webhook in den Chat.
 *   • Jeder Lauf endet mit einem strukturierten run_summary-Logeintrag und
 *     aktualisiert last_run_at (Basis des Docker-HEALTHCHECK).
 *
 * Von main.ts getrennt, damit die Loop-Logik ohne Scheduler/Prozess-Setup
 * testbar ist (Fake-Provider via `providerFactory`).
 */

export type RunSummary = {
  providersTotal: number;
  providersSucceeded: number;
  providersFailed: number;
  eventsSent: number;
  eventsFailed: number;
  opsSent: number;
  durationMs: number;
};

export type PollerDeps = {
  store: Store;
  notifier: Notifier;
  healthTracker: HealthTracker;
  /** Test-Hook: ersetzt die Adapter-Registry durch Fakes. */
  providerFactory?: (cfg: PlatformConfig, log: Logger) => SocialProvider;
};

/**
 * Ein Poll-Durchlauf für einen Provider. Wirft bei Fetch-Fehlern (der
 * Aufrufer kategorisiert sie für den HealthTracker); Sende-Fehler werden
 * hier isoliert und nur gezählt.
 */
async function pollProvider(
  provider: SocialProvider,
  store: Store,
  notifier: Notifier,
  summary: RunSummary,
): Promise<{ hasItems: boolean }> {
  const log = logger.child({ provider: provider.key });

  // Priorität 1: Posts im Sichtfenster holen und zentral registrieren —
  // die Registry füttert die Kommentar-Abfrage (Adapter bleiben zustandslos).
  const posts = await provider.fetchPosts();
  for (const post of posts) {
    if (post.type !== "post") continue;
    store.upsertPost(provider.key, {
      externalId: post.externalId,
      url: post.url,
      text: post.text,
      publishedAt: post.timestamp,
    });
  }

  // Priorität 2: Kommentare zu den jüngsten bekannten Posts.
  const recentPosts = store.getRecentPosts(provider.key);
  const comments = await provider.fetchComments(recentPosts);
  const events: SocialEvent[] = [...posts, ...comments];

  // Erstlauf: Bestand still als gesehen markieren, nichts senden.
  if (!store.isBootstrapped(provider.key)) {
    const now = new Date().toISOString();
    for (const event of events) {
      store.markSeen(provider.key, event.externalId, event.type, now);
    }
    store.markBootstrapped(provider.key);
    log.info({ seeded: events.length }, "Erstlauf: Bestand still eingelesen, nichts gesendet");
    return { hasItems: events.length > 0 };
  }

  for (const event of events) {
    if (store.hasSeen(provider.key, event.externalId)) continue;
    try {
      await notifier.send(event);
      store.markSeen(provider.key, event.externalId, event.type, new Date().toISOString());
      summary.eventsSent++;
    } catch (err) {
      // Nicht als gesehen markieren → nächster Durchlauf versucht es erneut.
      summary.eventsFailed++;
      log.error({ err, externalId: event.externalId }, "Senden fehlgeschlagen");
    }
  }

  return { hasItems: events.length > 0 };
}

/** Stabiler Config-Fingerprint — ändert er sich, resettet der HealthTracker. */
function fingerprint(cfg: PlatformConfig): string {
  return `${cfg.platform}:${JSON.stringify(cfg.options)}`;
}

function healthEventToOps(event: HealthEvent, cfg: PlatformConfig): OpsEvent {
  const name = cfg.name || cfg.key;
  const base = {
    schemaVersion: 1 as const,
    source: "social" as const,
    type: "ops" as const,
    platform: cfg.platform,
    provider: cfg.key,
    providerName: name,
    timestamp: new Date().toISOString(),
  };
  switch (event.kind) {
    case "down":
      return {
        ...base,
        kind: "down",
        errorCategory: event.errorCategory,
        durationLabel: formatDuration(event.downForMs),
        message: `${name}: Polling schlägt seit ${formatDuration(event.downForMs)} fehl (${event.errorCategory}).`,
      };
    case "recovered":
      return {
        ...base,
        kind: "recovered",
        durationLabel: formatDuration(event.downForMs),
        message: `${name}: Polling funktioniert wieder (war ${formatDuration(event.downForMs)} gestört).`,
      };
    case "halfDead":
      return {
        ...base,
        kind: "halfDead",
        durationLabel: formatDuration(event.sinceMs),
        message: `${name}: liefert seit ${formatDuration(event.sinceMs)} keinerlei Beiträge — vermutlich Fehlkonfiguration (Org-URN/Page-ID prüfen).`,
      };
  }
}

async function sendOpsIsolated(
  notifier: Notifier,
  event: OpsEvent,
  summary: RunSummary,
): Promise<void> {
  try {
    await notifier.sendOps(event);
    summary.opsSent++;
    logger.info({ provider: event.provider, kind: event.kind }, "Ops-Event gesendet");
  } catch (err) {
    logger.error({ provider: event.provider, kind: event.kind, err }, "Ops-Event fehlgeschlagen");
  }
}

/**
 * Ein vollständiger Poll-Zyklus über alle aktiven Provider. Wirft nie —
 * jedes Teilproblem wird isoliert geloggt und fließt in die zurückgegebene
 * RunSummary ein.
 */
export async function runOnce(platforms: PlatformConfig[], deps: PollerDeps): Promise<RunSummary> {
  const { store, notifier, healthTracker } = deps;
  const providerFactory = deps.providerFactory ?? createProvider;
  const startTime = Date.now();
  const active = platforms.filter((p) => p.enabled);
  const summary: RunSummary = {
    providersTotal: active.length,
    providersSucceeded: 0,
    providersFailed: 0,
    eventsSent: 0,
    eventsFailed: 0,
    opsSent: 0,
    durationMs: 0,
  };
  const healthInput: HealthPollResult[] = [];
  const cfgByKey = new Map(active.map((p) => [p.key, p]));

  // Token-Auto-Refresh VOR dem Fetch: injiziert frische Access-Tokens in die
  // tokenEnv der Provider; Warnungen (Refresh kaputt / Re-Autorisierung nötig)
  // gehen als Ops-Events raus.
  try {
    for (const event of await ensureFreshTokens(active, store, logger)) {
      await sendOpsIsolated(notifier, event, summary);
    }
  } catch (err) {
    logger.error({ err }, "Token-Auto-Refresh fehlgeschlagen");
  }

  const results = await Promise.allSettled(
    active.map(async (cfg) => {
      const provider = providerFactory(cfg, logger);
      return pollProvider(provider, store, notifier, summary);
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const cfg = active[i];
    if (result.status === "rejected") {
      summary.providersFailed++;
      logger.error({ provider: cfg.key, err: result.reason }, "Provider-Durchlauf fehlgeschlagen");
      healthInput.push({
        providerKey: cfg.key,
        providerName: cfg.name || cfg.key,
        fingerprint: fingerprint(cfg),
        outcome: { kind: "failure", errorCategory: categorizeError(result.reason) },
      });
    } else {
      summary.providersSucceeded++;
      healthInput.push({
        providerKey: cfg.key,
        providerName: cfg.name || cfg.key,
        fingerprint: fingerprint(cfg),
        outcome: { kind: "success", hasItems: result.value.hasItems },
      });
    }
  }

  // Health-Auswertung nach dem Provider-Loop, damit die globale
  // Unterdrückung die volle Fehlerquote des Zyklus kennt.
  try {
    for (const event of healthTracker.ingest(healthInput)) {
      const cfg = cfgByKey.get(event.providerKey);
      if (!cfg) continue;
      await sendOpsIsolated(notifier, healthEventToOps(event, cfg), summary);
    }
  } catch (err) {
    logger.error({ err }, "HealthTracker-Auswertung fehlgeschlagen");
  }

  // Statischer Token-Watchdog (tokenExpiresAt) — nur für Provider OHNE
  // Auto-Refresh, sonst gäbe es doppelte Warnungen.
  try {
    for (const event of checkTokenExpiry(
      active.filter((p) => !hasRefreshConfig(p)),
      store,
    )) {
      await sendOpsIsolated(notifier, event, summary);
    }
  } catch (err) {
    logger.error({ err }, "Token-Watchdog fehlgeschlagen");
  }

  try {
    store.pruneOldPosts();
    store.setMeta(LAST_RUN_METADATA_KEY, new Date().toISOString());
  } catch (err) {
    logger.error({ err }, "State-Pflege (prune/last_run_at) fehlgeschlagen");
  }

  summary.durationMs = Date.now() - startTime;
  logger.info({ run_summary: summary }, "run_summary");
  return summary;
}
