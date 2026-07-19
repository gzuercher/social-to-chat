import { copyFileSync, existsSync, statSync } from "node:fs";
import { Cron } from "croner";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { HealthTracker } from "./lib/healthTracker.js";
import { Store } from "./state/store.js";
import { WebhookNotifier } from "./notify/webhook.js";
import { runOnce } from "./poller.js";
import { runHealthcheck } from "./cli/health.js";
import { runValidate } from "./cli/validate.js";
import { runSetup } from "./cli/setup.js";
import { loadEnvFile } from "./lib/envFile.js";

/**
 * Seedet die platforms.yaml beim ersten Start aus dem Template (Muster
 * gespiegelt von status-page-to-chat): ermöglicht `docker compose up -d`
 * mit leerem State-Volume — die Datei landet einmalig im Volume, der
 * Setup-Wizard patcht sie danach. Im Template sind alle Plattformen
 * deaktiviert, der Seed ist also gefahrlos. Beide ENV setzt das Dockerfile;
 * außerhalb des Containers ist die Funktion ein No-op.
 */
function seedConfigFileIfMissing(): void {
  const configPath = process.env.CONFIG_PATH;
  const templatePath = process.env.PLATFORMS_TEMPLATE_PATH;
  if (!configPath || !templatePath) return;
  // Leere Datei = „fehlt" (Überbleibsel eines früheren Deployments).
  if (existsSync(configPath)) {
    try {
      if (statSync(configPath).size > 0) return;
    } catch {
      return;
    }
  }
  if (!existsSync(templatePath)) {
    logger.warn({ configPath, templatePath }, "Seed-Template fehlt, überspringe Config-Seeding");
    return;
  }
  try {
    copyFileSync(templatePath, configPath);
    logger.info({ from: templatePath, to: configPath }, "platforms.yaml aus Template geseedet");
  } catch (err) {
    logger.error({ err, configPath, templatePath }, "Config-Seeding fehlgeschlagen");
  }
}

/**
 * Container-Entrypoint (Muster gespiegelt von status-page-to-chat):
 * Config laden, sofort einen Lauf starten (Logs zeigen schnell Aktivität),
 * dann nach Zeitplan. Läufe überlappen nie (croner protect + isRunning-
 * Guard), SIGTERM/SIGINT warten auf den laufenden Zyklus (Drain).
 * Die eigentliche Poll-Logik lebt testbar in poller.ts.
 */
async function main(): Promise<void> {
  seedConfigFileIfMissing();
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const notifier = new WebhookNotifier(config.webhookUrl, logger);
  const healthTracker = new HealthTracker();

  let currentPlatforms = config.platforms;
  let isRunning = false;
  let shuttingDown = false;

  if (currentPlatforms.filter((p) => p.enabled).length === 0) {
    logger.warn("Keine aktiven Plattformen konfiguriert — nichts zu tun.");
  }

  const tick = async (): Promise<void> => {
    if (shuttingDown || isRunning) return;
    isRunning = true;
    try {
      // Config vor jedem Zyklus neu einlesen, damit Änderungen an der
      // Plattform-Liste ohne Neustart greifen. Bei kaputter Datei läuft
      // der letzte gute Stand weiter.
      try {
        currentPlatforms = loadConfig().platforms;
      } catch (err) {
        logger.warn({ err }, "Config-Reload fehlgeschlagen, nutze letzten guten Stand");
      }
      await runOnce(currentPlatforms, { store, notifier, healthTracker });
    } finally {
      isRunning = false;
    }
  };

  const job = new Cron(config.schedule, { protect: true }, () => void tick());
  logger.info(
    {
      schedule: config.schedule,
      nextRun: job.nextRun()?.toISOString() ?? null,
      providers: currentPlatforms.filter((p) => p.enabled).map((p) => p.key),
    },
    "social-to-chat gestartet",
  );

  await tick();

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutdown-Signal empfangen, stoppe Scheduler");
    job.stop();

    const waitForRun = (): void => {
      if (!isRunning) {
        store.close();
        logger.info("Shutdown abgeschlossen");
        process.exit(0);
      } else {
        setTimeout(waitForRun, 200);
      }
    };
    waitForRun();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// .env laden (falls vorhanden) — bereits gesetzte Container-ENV hat Vorrang.
// Macht `poll`/`validate` direkt nach dem Setup-Wizard lauffähig.
loadEnvFile(process.env.ENV_PATH ?? "./.env");

const subcommand = process.argv[2];

if (subcommand === "validate") {
  runValidate();
} else if (subcommand === "health") {
  runHealthcheck();
} else if (subcommand === "setup") {
  runSetup();
} else if (subcommand === undefined || subcommand === "poll") {
  main().catch((err: unknown) => {
    logger.fatal({ err }, "Poller konnte nicht starten");
    process.exit(1);
  });
} else {
  process.stderr.write(
    `Unbekannter Subcommand: ${subcommand}\n` +
      `Usage: node dist/src/main.js [poll|validate|health|setup]\n`,
  );
  process.exit(2);
}
