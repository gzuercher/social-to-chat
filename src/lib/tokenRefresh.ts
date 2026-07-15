import { z } from "zod";
import type { PlatformConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { httpPost } from "./httpClient.js";
import { parseJson } from "./json.js";
import { categorizeError } from "./errorCategory.js";
import type { OpsEvent, Platform } from "../platforms/types.js";
import type { Store } from "../state/store.js";

/**
 * Token-Auto-Refresh (Ausbaustufe 2 des Token-Managements).
 *
 * Ziel: maximale Automatisierung — nach einer EINMALIGEN menschlichen
 * Autorisierung (OAuth-Consent, siehe docs/TOKENS.md) erneuert der Poller
 * seine Access-Tokens selbst:
 *
 *   • LinkedIn: Access-Token 60 Tage, Refresh-Token 365 Tage.
 *   • TikTok:   Access-Token 24 h, Refresh-Token 365 Tage (rotiert bei jedem
 *     Refresh mit → läuft der Poller regelmäßig, praktisch unbegrenzt).
 *   • Facebook/Instagram: KEIN Refresh-Token-Mechanismus — maximale
 *     Automatisierung dort = System-User-Token (läuft nie ab, docs/TOKENS.md).
 *
 * Funktionsweise:
 *   1. Der Token-Zustand (Access-/Refresh-Token + Abläufe) lebt in der
 *      metadata-Tabelle des Stores und überlebt Container-Neustarts —
 *      wichtig, weil rotierte Refresh-Tokens die ENV-Werte veralten lassen.
 *   2. Vor jedem Poll-Zyklus wird der gespeicherte Access-Token in
 *      process.env[tokenEnv] injiziert (die Adapter lesen weiterhin nur ENV).
 *   3. Ist der Access-Token abgelaufen oder nah dran (Margin je Plattform),
 *      wird er über den OAuth-Refresh-Endpunkt erneuert.
 *   4. Ändert der Operator den Refresh-Token in der ENV (= neue manuelle
 *      Autorisierung), verwirft der Manager den gespeicherten Zustand und
 *      übernimmt die neuen Werte.
 *   5. Läuft der REFRESH-Token ab (dann muss ein Mensch neu autorisieren),
 *      warnt ein Ops-Event bei T-14/7/1/0 — wie der statische Watchdog.
 *      Fehlgeschlagene Refreshes werden ebenfalls gemeldet (max. 1×/24 h).
 *
 * Konfiguration je Provider (options.refresh, Secrets via ENV-Namen):
 *   refresh:
 *     refreshTokenEnv: "LINKEDIN_REFRESH_TOKEN"
 *     clientIdEnv:     "LINKEDIN_CLIENT_ID"      (TikTok: client_key)
 *     clientSecretEnv: "LINKEDIN_CLIENT_SECRET"
 */

const refreshOptionsSchema = z.object({
  refreshTokenEnv: z.string().min(1),
  clientIdEnv: z.string().min(1),
  clientSecretEnv: z.string().min(1),
});

export type RefreshOptions = z.infer<typeof refreshOptionsSchema>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** OAuth-Token-Endpunkte der Plattformen mit Refresh-Unterstützung. */
const REFRESH_ENDPOINTS: Partial<Record<Platform, string>> = {
  linkedin: "https://www.linkedin.com/oauth/v2/accessToken",
  tiktok: "https://open.tiktokapis.com/v2/oauth/token/",
};

/** Access-Token wird erneuert, wenn weniger Restlaufzeit als diese Margin bleibt. */
const ACCESS_MARGIN_MS: Partial<Record<Platform, number>> = {
  linkedin: 7 * DAY_MS, // 60-Tage-Token → eine Woche Puffer
  tiktok: 2 * HOUR_MS, // 24-h-Token → zwei Stunden Puffer
};

/** Warnstufen (Resttage) für den Ablauf des REFRESH-Tokens. 0 = abgelaufen. */
const REFRESH_WARN_THRESHOLDS_DAYS = [14, 7, 1, 0] as const;

/** Fehlgeschlagene Refreshes höchstens einmal pro Intervall in den Chat melden. */
const FAILURE_WARN_INTERVAL_MS = 24 * HOUR_MS;

type TokenState = {
  /** ENV-Refresh-Token bei Übernahme — erkennt eine neue manuelle Autorisierung. */
  seedRefreshToken: string;
  refreshToken: string;
  refreshExpiresAt?: string;
  accessToken: string;
  accessExpiresAt?: string;
  /** Bereits gemeldete Refresh-Ablauf-Warnstufen. */
  warnedThresholds: number[];
  lastFailureWarnAt?: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  // TikTok meldet Fehler teils mit HTTP 200 im Body:
  error?: string;
  error_description?: string;
};

function metaKey(providerKey: string): string {
  return `oauthToken:${providerKey}`;
}

function loadState(store: Store, providerKey: string): TokenState | undefined {
  const raw = store.getMeta(metaKey(providerKey));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as TokenState;
  } catch {
    return undefined;
  }
}

function saveState(store: Store, providerKey: string, state: TokenState): void {
  store.setMeta(metaKey(providerKey), JSON.stringify(state));
}

function requireEnv(name: string, providerKey: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${providerKey}: ENV ${name} ist nicht gesetzt (Token-Refresh)`);
  return value;
}

/** Form-Body des Refresh-Requests — Parameternamen unterscheiden sich je Plattform. */
function buildRefreshBody(
  platform: Platform,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): string {
  const params = new URLSearchParams(
    platform === "tiktok"
      ? {
          client_key: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }
      : {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        },
  );
  return params.toString();
}

async function requestRefresh(
  platform: Platform,
  endpoint: string,
  body: string,
): Promise<OAuthTokenResponse> {
  const res = await httpPost(endpoint, body, {
    contentType: "application/x-www-form-urlencoded",
  });
  if (res.status !== 200) {
    throw new Error(`${platform} token refresh: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const data = parseJson<OAuthTokenResponse>(res.body, `${platform} token refresh`);
  if (data.error) {
    throw new Error(`${platform} token refresh: ${data.error}: ${data.error_description ?? ""}`);
  }
  if (!data.access_token) {
    throw new Error(`${platform} token refresh: Antwort ohne access_token`);
  }
  return data;
}

function opsEvent(
  cfg: PlatformConfig,
  message: string,
  extras: Partial<Pick<OpsEvent, "daysLeft" | "errorCategory">>,
  nowMs: number,
): OpsEvent {
  return {
    schemaVersion: 1,
    source: "social",
    type: "ops",
    kind: "tokenExpiry",
    platform: cfg.platform,
    provider: cfg.key,
    providerName: cfg.name || cfg.key,
    message,
    timestamp: new Date(nowMs).toISOString(),
    ...extras,
  };
}

/** True, wenn dieser Provider Auto-Refresh konfiguriert hat. */
export function hasRefreshConfig(cfg: PlatformConfig): boolean {
  return typeof cfg.options.refresh === "object" && cfg.options.refresh !== null;
}

/**
 * Stellt vor einem Poll-Zyklus sicher, dass alle Auto-Refresh-Provider einen
 * frischen Access-Token in ihrer tokenEnv haben. Liefert fällige Ops-Events
 * (Refresh fehlgeschlagen / Refresh-Token läuft ab); der Aufrufer versendet sie.
 */
export async function ensureFreshTokens(
  providers: PlatformConfig[],
  store: Store,
  log: Logger,
  now: () => number = Date.now,
): Promise<OpsEvent[]> {
  const events: OpsEvent[] = [];

  for (const cfg of providers) {
    if (!hasRefreshConfig(cfg)) continue;
    const scoped = log.child({ provider: cfg.key });

    try {
      const endpoint = REFRESH_ENDPOINTS[cfg.platform];
      if (!endpoint) {
        scoped.warn(
          { platform: cfg.platform },
          "options.refresh gesetzt, aber Plattform hat keinen Refresh-Flow (siehe docs/TOKENS.md)",
        );
        continue;
      }

      const parsed = refreshOptionsSchema.safeParse(cfg.options.refresh);
      if (!parsed.success) {
        scoped.error({ err: parsed.error.message }, "options.refresh ungültig");
        continue;
      }
      const opts = parsed.data;
      const tokenEnv = typeof cfg.options.tokenEnv === "string" ? cfg.options.tokenEnv : undefined;
      if (!tokenEnv) {
        scoped.error("options.tokenEnv fehlt — Refresh kann den Token nirgends ablegen");
        continue;
      }

      const envRefreshToken = requireEnv(opts.refreshTokenEnv, cfg.key);
      const nowMs = now();

      // Zustand laden; neue manuelle Autorisierung (ENV geändert) → Neustart.
      let state = loadState(store, cfg.key);
      if (!state || state.seedRefreshToken !== envRefreshToken) {
        state = {
          seedRefreshToken: envRefreshToken,
          refreshToken: envRefreshToken,
          accessToken: process.env[tokenEnv] ?? "",
          warnedThresholds: [],
        };
        scoped.info("Token-Zustand (neu) aus ENV übernommen");
      }

      // Gespeicherten Access-Token für die Adapter bereitstellen.
      if (state.accessToken) process.env[tokenEnv] = state.accessToken;

      // Fällig? Unbekannter Ablauf zählt als fällig (erster Lauf).
      const margin = ACCESS_MARGIN_MS[cfg.platform] ?? DAY_MS;
      const due =
        !state.accessToken ||
        !state.accessExpiresAt ||
        Date.parse(state.accessExpiresAt) - nowMs < margin;

      if (due) {
        try {
          const clientId = requireEnv(opts.clientIdEnv, cfg.key);
          const clientSecret = requireEnv(opts.clientSecretEnv, cfg.key);
          const body = buildRefreshBody(cfg.platform, state.refreshToken, clientId, clientSecret);
          const data = await requestRefresh(cfg.platform, endpoint, body);

          state.accessToken = data.access_token ?? state.accessToken;
          if (data.expires_in) {
            state.accessExpiresAt = new Date(nowMs + data.expires_in * 1000).toISOString();
          }
          // Rotierten Refresh-Token übernehmen (TikTok rotiert immer).
          if (data.refresh_token) state.refreshToken = data.refresh_token;
          if (data.refresh_token_expires_in) {
            state.refreshExpiresAt = new Date(
              nowMs + data.refresh_token_expires_in * 1000,
            ).toISOString();
            state.warnedThresholds = [];
          }
          process.env[tokenEnv] = state.accessToken;
          scoped.info(
            { accessExpiresAt: state.accessExpiresAt, refreshExpiresAt: state.refreshExpiresAt },
            "Access-Token erneuert",
          );
        } catch (err) {
          scoped.error({ err }, "Token-Refresh fehlgeschlagen");
          const lastWarn = state.lastFailureWarnAt ? Date.parse(state.lastFailureWarnAt) : 0;
          if (nowMs - lastWarn >= FAILURE_WARN_INTERVAL_MS) {
            state.lastFailureWarnAt = new Date(nowMs).toISOString();
            events.push(
              opsEvent(
                cfg,
                `Auto-Refresh des ${cfg.platform}-Tokens für ${cfg.name || cfg.key} schlägt fehl` +
                  ` (${categorizeError(err)}). Ohne gültigen Token stoppt der Adapter —` +
                  ` ggf. neu autorisieren (docs/TOKENS.md).`,
                { errorCategory: categorizeError(err) },
                nowMs,
              ),
            );
          }
        }
      }

      // Ablauf des REFRESH-Tokens: dann muss ein Mensch neu autorisieren.
      if (state.refreshExpiresAt) {
        const daysLeft = Math.max(
          0,
          Math.ceil((Date.parse(state.refreshExpiresAt) - nowMs) / DAY_MS),
        );
        const due = [...REFRESH_WARN_THRESHOLDS_DAYS].reverse().find((t) => daysLeft <= t);
        if (due !== undefined && !state.warnedThresholds.includes(due)) {
          state.warnedThresholds = REFRESH_WARN_THRESHOLDS_DAYS.filter((t) => t >= due);
          events.push(
            opsEvent(
              cfg,
              daysLeft === 0
                ? `Der Refresh-Token für ${cfg.name || cfg.key} ist abgelaufen — einmalige` +
                    ` Re-Autorisierung durch einen Menschen nötig (docs/TOKENS.md).`
                : `Der Refresh-Token für ${cfg.name || cfg.key} läuft in ${daysLeft} Tag` +
                    `${daysLeft === 1 ? "" : "en"} ab — bitte einmalig neu autorisieren` +
                    ` (docs/TOKENS.md).`,
              { daysLeft },
              nowMs,
            ),
          );
        }
      }

      saveState(store, cfg.key, state);
    } catch (err) {
      // Provider-Isolation: ein kaputter Refresh-Setup darf die anderen
      // (und den Poll-Zyklus) nicht blockieren.
      scoped.error({ err }, "Token-Refresh-Verarbeitung fehlgeschlagen");
    }
  }

  return events;
}
