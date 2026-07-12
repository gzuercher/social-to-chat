import { Cron } from "croner";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { Store } from "./state/store.js";
import { WebhookNotifier } from "./notify/webhook.js";
import { createProvider } from "./platforms/index.js";
import type { SocialEvent, SocialProvider } from "./platforms/types.js";

/**
 * Ein Poll-Durchlauf für einen Provider. Reihenfolge = Prioritäten:
 * erst neue Posts, dann neue Kommentare. (Statistiken folgen später als
 * eigener, seltenerer Job — hier noch nicht verdrahtet.)
 * Dedup: nur Events, die der Store noch nicht gesehen hat, werden verschickt.
 */
async function pollProvider(
  provider: SocialProvider,
  store: Store,
  notifier: WebhookNotifier,
): Promise<void> {
  const log = logger.child({ provider: provider.key });
  const events: SocialEvent[] = [
    ...(await provider.fetchNewPosts()),
    ...(await provider.fetchNewComments()),
  ];

  for (const event of events) {
    if (store.hasSeen(provider.key, event.externalId)) continue;
    try {
      await notifier.send(event);
      store.markSeen(provider.key, event.externalId, event.type, new Date().toISOString());
    } catch (err) {
      // Nicht als gesehen markieren → nächster Durchlauf versucht es erneut.
      log.error({ err, externalId: event.externalId }, "Senden fehlgeschlagen");
    }
  }
}

async function runOnce(
  providers: SocialProvider[],
  store: Store,
  notifier: WebhookNotifier,
): Promise<void> {
  for (const provider of providers) {
    try {
      await pollProvider(provider, store, notifier);
    } catch (err) {
      logger.error({ err, provider: provider.key }, "Provider-Durchlauf fehlgeschlagen");
    }
  }
}

function main(): void {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const notifier = new WebhookNotifier(config.webhookUrl, logger);
  const providers = config.platforms.filter((p) => p.enabled).map((p) => createProvider(p, logger));

  logger.info(
    { schedule: config.schedule, providers: providers.map((p) => p.key) },
    "social-to-chat gestartet",
  );

  if (providers.length === 0) {
    logger.warn("Keine aktiven Plattformen konfiguriert — nichts zu tun.");
  }

  // Sofort einmal laufen, dann nach Zeitplan.
  void runOnce(providers, store, notifier);
  new Cron(config.schedule, () => void runOnce(providers, store, notifier));

  const shutdown = (): void => {
    logger.info("shutdown");
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
