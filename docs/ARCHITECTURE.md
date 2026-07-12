# Architektur

```
                 ┌──────────────────────────── social-to-chat (Container) ───────────┐
                 │                                                                    │
  Cron (croner)  │   main.ts ── für jeden aktiven Provider:                           │
   alle N min ───┼──▶  1. fetchNewPosts()      ┐                                       │
                 │     2. fetchNewComments()   ├─▶ Dedup (Store/SQLite) ─▶ Notifier ──┼──▶ WEBHOOK_URL
                 │     (3. fetchStats() später)┘         seen_events         POST JSON │    (social-feed
                 │                                                                    │     Logic App →
                 │   Adapter-Registry: linkedin | facebook | instagram | tiktok       │     Teams-Karte)
                 └────────────────────────────────────────────────────────────────────┘
```

## Bausteine

| Datei | Rolle |
|---|---|
| `src/platforms/types.ts` | Datenmodell + `SocialProvider`-Interface |
| `src/platforms/index.ts` | Registry `createProvider(cfg)` |
| `src/platforms/*.ts` | ein Adapter je Plattform (aktuell Stubs) |
| `src/lib/config.ts` | YAML-Struktur + ENV-Secrets, zod-validiert |
| `src/lib/logger.ts` | pino, redigiert Secrets |
| `src/lib/httpClient.ts` | undici-Wrapper |
| `src/state/store.ts` | SQLite-Deduplizierung (`seen_events`) |
| `src/notify/webhook.ts` | POST an konfigurierbaren Webhook |
| `src/main.ts` | Scheduler + Poll-Orchestrierung |

## Datenfluss

1. Der Scheduler ruft je aktivem Provider `fetchNewPosts()`, dann
   `fetchNewComments()` auf (Reihenfolge = Priorität).
2. Jedes zurückgegebene `SocialEvent` trägt eine stabile `externalId`.
3. Der `Store` filtert bereits gesehene Events (Dedup pro `provider_key`).
4. Neue Events gehen per `WebhookNotifier` als JSON-Contract raus; erst nach
   erfolgreichem Versand werden sie als „gesehen" markiert (fehlgeschlagene
   werden im nächsten Lauf erneut versucht).

## Warum Dedup nötig ist
Die Plattform-APIs sind Pull, nicht Push: jeder Lauf sieht denselben Bestand.
Ohne persistente „schon gemeldet"-Markierung würde jeder Durchlauf alles neu
verschicken.

## Erweitern um eine Plattform
1. Datei in `src/platforms/` anlegen, die `SocialProvider` implementiert.
2. In `src/platforms/index.ts` importieren und `case` ergänzen.
3. Eintrag in `config/platforms.yaml`.

## Sicherheit / Secrets
Secrets ausschließlich aus ENV (`WEBHOOK_URL`, `*_ACCESS_TOKEN`); die YAML
referenziert sie als `${ENV}`. Logger redigiert `webhookUrl`/Tokens. Das Repo
ist Open Source — nichts Geheimes committen.
