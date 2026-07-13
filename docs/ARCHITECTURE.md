# Architektur

```
                 ┌──────────────────────────── social-to-chat (Container) ──────────────┐
                 │                                                                       │
  Cron (croner)  │   main.ts ─▶ poller.ts: für jeden aktiven Provider (parallel):        │
  protect:true ──┼──▶  1. fetchPosts()            ─▶ Post-Registry (Store)               │
                 │     2. fetchComments(recentPosts)                                     │
                 │        └─▶ Dedup (seen_events) ─▶ WebhookNotifier ── POST JSON ───────┼──▶ WEBHOOK_URL
                 │                                                                       │    (social-feed
                 │   HealthTracker (down/recovered/half-dead)  ┐                         │     Logic App →
                 │   Token-Watchdog (T-14/7/1, abgelaufen)     ├─▶ Ops-Events ───────────┼──▶  Teams-Karte)
                 │                                             ┘   (type: "ops")         │
                 │   Adapter-Registry: linkedin | facebook | instagram | tiktok          │
                 └───────────────────────────────────────────────────────────────────────┘
```

Betriebsmuster gespiegelt von `status-page-to-chat` (Familienstandard):
gespiegelte Module tragen einen entsprechenden Header-Kommentar — Änderungen
dort immer in beiden Repos nachziehen.

## Bausteine

| Datei | Rolle |
|---|---|
| `src/platforms/types.ts` | Datenmodell: `SocialEvent`, `OpsEvent`, `PostRef` + `SocialProvider`-Interface |
| `src/platforms/index.ts` | Registry `createProvider(cfg)` |
| `src/platforms/*.ts` | ein Adapter je Plattform (aktuell Stubs), **zustandslos** |
| `src/poller.ts` | Poll-Zyklus: Fetch → Registry → Dedup → Versand → Health/Token-Ops |
| `src/main.ts` | Entrypoint: Scheduler (protect), Config-Reload, Drain-Shutdown, Subcommands |
| `src/lib/config.ts` | YAML-Struktur + ENV-Secrets, zod-validiert (ENV > YAML > Default) |
| `src/lib/healthTracker.ts` | *(gespiegelt)* down/recovered/half-dead-Erkennung mit globaler Unterdrückung |
| `src/lib/errorCategory.ts` | *(gespiegelt)* Fehler → chat-taugliche Kurzkategorie |
| `src/lib/httpClient.ts` | *(gespiegelt)* Timeout, User-Agent, Retry/Backoff für 429/5xx |
| `src/lib/tokenWatchdog.ts` | Token-Ablauf-Warnungen (T-14/7/1/abgelaufen) als Ops-Events |
| `src/lib/logger.ts` | pino, redigiert Secrets |
| `src/state/store.ts` | SQLite: `seen_events` (Dedup), `posts` (Registry), `metadata` |
| `src/notify/webhook.ts` | POST Social-/Ops-Events an konfigurierbaren Webhook |
| `src/cli/health.ts` | Docker-HEALTHCHECK: last_run_at < 15 min |
| `src/cli/validate.ts` | Config-Validierung ohne Seiteneffekte |

## Datenfluss

1. Der Scheduler ruft je aktivem Provider `fetchPosts()` auf; die Posts landen
   in der zentralen Post-Registry (`posts`-Tabelle).
2. `fetchComments(recentPosts)` bekommt die jüngsten bekannten Posts (30-Tage-
   Fenster) übergeben — **Adapter bleiben zustandslos**, aller State ist zentral.
3. Adapter liefern den Bestand im Sichtfenster, ungefiltert. Was *neu* ist,
   entscheidet der Loop per Dedup (`seen_events`, pro `provider_key`).
4. Neue Events gehen per `WebhookNotifier` als JSON-Contract raus; erst nach
   erfolgreichem Versand werden sie als „gesehen" markiert (fehlgeschlagene
   werden im nächsten Lauf erneut versucht — at-least-once).
5. **Erstlauf pro Provider (Bootstrap):** Bestand wird still als gesehen
   markiert, nichts gesendet — kein Flood im Chat bei leerer Datenbank.
6. Nach dem Provider-Loop werten HealthTracker und Token-Watchdog den Zyklus
   aus und schicken fällige **Ops-Events** durch denselben Webhook.
7. Jeder Lauf endet mit `run_summary`-Logeintrag und aktualisiert
   `metadata.last_run_at` — darauf prüft der Docker-`HEALTHCHECK`
   (`node dist/src/main.js health`).

## Selbstüberwachung (Ops-Events)

Der Teams-Kanal ist zugleich der Alarmkanal des Pollers — kein separates
Monitoring nötig:

| `kind` | Auslöser |
|---|---|
| `down` | Adapter scheitert 24 Läufe in Folge (~2 h); Fehlerkategorie inklusive. Globale Unterdrückung: fallen >50 % aller Adapter gleichzeitig aus, ist es fast sicher das lokale Netz → kein Alarm-Flood |
| `recovered` | 2 fehlerfreie Läufe nach einem `down` |
| `halfDead` | Adapter läuft 7 Tage fehlerfrei, liefert aber nie Items → vermutlich Fehlkonfiguration (Org-URN/Page-ID) |
| `tokenExpiry` | `tokenExpiresAt` unterschreitet 14/7/1 Tage bzw. ist abgelaufen (je einmal; Reset bei neuem Datum) |

Zusätzlich kategorisiert `errorCategory` 401/403 sofort als
„Authentication failed" — abgelaufene Tokens fallen also auch ohne
konfiguriertes `tokenExpiresAt` nach dem down-Schwellwert auf.

## Warum Dedup nötig ist

Die Plattform-APIs sind Pull, nicht Push: jeder Lauf sieht denselben Bestand.
Ohne persistente „schon gemeldet"-Markierung würde jeder Durchlauf alles neu
verschicken.

## Erweitern um eine Plattform

1. Datei in `src/platforms/` anlegen, die `SocialProvider` implementiert
   (zustandslos; Bestand im Sichtfenster liefern, Fehler werfen).
2. In `src/platforms/index.ts` importieren und `case` ergänzen.
3. Eintrag in `config/platforms.yaml`.

## Sicherheit / Secrets

Secrets ausschließlich aus ENV (`WEBHOOK_URL`, `*_ACCESS_TOKEN`); die YAML
referenziert sie als `${ENV}`. Logger redigiert `webhookUrl`/Tokens. Das Repo
ist Open Source — nichts Geheimes committen.
