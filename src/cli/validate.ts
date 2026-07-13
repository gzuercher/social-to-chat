import { loadConfig } from "../lib/config.js";

/**
 * Subcommand: Config-Validierung ohne Seiteneffekte.
 *
 * Lädt die YAML inkl. ENV-Auflösung und zod-Validierung und gibt eine
 * kompakte Zusammenfassung aus. Exit 0 bei gültiger Config, 1 sonst.
 * Gedacht für CI und für den Operator nach Config-Änderungen
 * (`node dist/src/main.js validate`).
 */
export function runValidate(): void {
  try {
    const config = loadConfig();
    const active = config.platforms.filter((p) => p.enabled);
    process.stdout.write(
      `ok: ${config.platforms.length} Plattform(en) konfiguriert, ${active.length} aktiv ` +
        `[${active.map((p) => p.key).join(", ")}], schedule "${config.schedule}", db "${config.dbPath}"\n`,
    );
    for (const p of active) {
      if (!p.tokenExpiresAt) {
        process.stdout.write(
          `  hint: ${p.key} hat kein tokenExpiresAt — der Token-Watchdog kann nicht vorwarnen.\n`,
        );
      }
    }
    process.exit(0);
  } catch (err) {
    process.stdout.write(`invalid: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
