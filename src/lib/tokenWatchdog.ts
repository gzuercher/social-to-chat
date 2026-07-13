import type { PlatformConfig } from "./config.js";
import type { OpsEvent } from "../platforms/types.js";
import type { Store } from "../state/store.js";

/**
 * Token-Ablauf-Watchdog (Ausbaustufe 1: warnen, nicht erneuern).
 *
 * Plattform-Tokens sind das größte Betriebsrisiko dieses Pollers: LinkedIn-
 * Tokens leben 60 Tage, Meta-Tokens ~60 Tage — läuft eines ab, stirbt der
 * Adapter *leise*. Der Watchdog liest `tokenExpiresAt` aus der Provider-Config
 * und feuert Ops-Events in den Chat, bevor es so weit ist:
 *
 *   • einmal bei ≤14 Tagen Restlaufzeit
 *   • einmal bei ≤7 Tagen
 *   • einmal bei ≤1 Tag
 *   • einmal bei/nach Ablauf (daysLeft 0)
 *
 * Der „einmal"-Zustand wird pro Provider in der metadata-Tabelle gehalten und
 * an das konfigurierte Ablaufdatum gebunden: trägt der Operator nach dem
 * Erneuern ein neues Datum ein, setzen sich die Warnstufen automatisch zurück.
 *
 * Abgelaufene/entzogene Tokens, die die Plattform mit 401/403 quittiert,
 * fängt unabhängig davon der HealthTracker ("Authentication failed").
 */

/** Warnstufen in Resttagen, absteigend. 0 = abgelaufen. */
export const WARN_THRESHOLDS_DAYS = [14, 7, 1, 0] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type WarnState = {
  /** Das Ablaufdatum, auf das sich die verschickten Warnungen beziehen. */
  expiresAt: string;
  /** Bereits gemeldete Stufen (Werte aus WARN_THRESHOLDS_DAYS). */
  warned: number[];
};

function metaKey(providerKey: string): string {
  return `tokenWarn:${providerKey}`;
}

function readWarnState(store: Store, providerKey: string, expiresAt: string): WarnState {
  const raw = store.getMeta(metaKey(providerKey));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WarnState;
      // Neues Ablaufdatum konfiguriert → Token wurde erneuert → Reset.
      if (parsed.expiresAt === expiresAt) return parsed;
    } catch {
      // korrupter Eintrag → wie „nie gewarnt" behandeln
    }
  }
  return { expiresAt, warned: [] };
}

/**
 * Prüft alle Provider mit konfiguriertem `tokenExpiresAt` und liefert die
 * fälligen Ops-Events. Persistiert den Warn-Zustand, d. h. der Aufrufer muss
 * die Events anschließend wirklich versenden (Verlust ist verschmerzbar —
 * die nächste Stufe warnt erneut).
 */
export function checkTokenExpiry(
  providers: PlatformConfig[],
  store: Store,
  now: () => number = Date.now,
): OpsEvent[] {
  const events: OpsEvent[] = [];

  for (const provider of providers) {
    if (!provider.tokenExpiresAt) continue;

    // Ablauf am Ende des konfigurierten Tages (UTC) — großzügig gerundet.
    const expiryMs = Date.parse(`${provider.tokenExpiresAt}T23:59:59Z`);
    if (Number.isNaN(expiryMs)) continue;

    const daysLeft = Math.max(0, Math.ceil((expiryMs - now()) / MS_PER_DAY));
    // Dringendste fällige Stufe = kleinster Schwellwert ≥ daysLeft
    // (aufsteigend suchen; die Konstante ist absteigend deklariert).
    const due = [...WARN_THRESHOLDS_DAYS].reverse().find((t) => daysLeft <= t);
    if (due === undefined) continue;

    const state = readWarnState(store, provider.key, provider.tokenExpiresAt);
    if (state.warned.includes(due)) continue;

    // Alle Stufen ≥ der jetzt fälligen mit-quittieren: wer erst bei T-3
    // konfiguriert, bekommt eine Warnung (T-7), nicht drei nachgeholte.
    state.warned = WARN_THRESHOLDS_DAYS.filter((t) => t >= due);
    store.setMeta(metaKey(provider.key), JSON.stringify(state));

    const name = provider.name || provider.key;
    events.push({
      schemaVersion: 1,
      source: "social",
      type: "ops",
      kind: "tokenExpiry",
      platform: provider.platform,
      provider: provider.key,
      providerName: name,
      daysLeft,
      message:
        daysLeft === 0
          ? `Das API-Token für ${name} ist abgelaufen — der Adapter kann nicht mehr pollen. Bitte Token erneuern und tokenExpiresAt nachführen.`
          : `Das API-Token für ${name} läuft in ${daysLeft} Tag${daysLeft === 1 ? "" : "en"} ab (${provider.tokenExpiresAt}). Bitte rechtzeitig erneuern.`,
      timestamp: new Date(now()).toISOString(),
    });
  }

  return events;
}
