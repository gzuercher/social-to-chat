# CLAUDE.md — Handoff & Kontext für social-to-chat

Kurzkontext für Claude Code in künftigen Sessions. Dies ist ein **Grundgerüst**;
die Adapter sind bewusst noch Stubs.

## Was das ist
Selbst gehosteter Poller (TypeScript/Node-Container), der die Social-Media-Seiten
der Raptus AG beobachtet und **neue Posts / Kommentare / Statistiken** als JSON
an einen konfigurierbaren Webhook schickt. Bei Raptus zeigt der Webhook auf die
Logic App `social-feed` (Repo `msteams-feeds-automate`), die daraus zentral die
Teams-Adaptive-Card rendert. Schwester-Projekt von `status-page-to-chat` (dessen
Konventionen gespiegelt sind).

**Bewusst kein Drittanbieter-SaaS** (kein MAKE/n8n) — eigener Container.

## Prioritäten (Reihenfolge der Umsetzung)
1. **Neue Posts** – alle Plattformen
2. **Kommentare/Fragen** – LinkedIn/Facebook/Instagram (**TikTok ausgeschlossen**)
3. **Statistiken** – alle Plattformen (nur Zahlen)
4. (später) Digest

## Architektur (IST)
- `src/platforms/types.ts` — Kernmodell: `SocialEvent`, `SocialStats`,
  `SocialProvider` (Interface pro Plattform), `Notifier`.
- `src/platforms/index.ts` — `createProvider()`-Registry (switch pro Plattform).
- `src/platforms/{linkedin,facebook,instagram,tiktok}.ts` — **Stubs** mit
  dokumentierten API-Endpunkten, Scopes und `TODO(Priorität N)`. Alle
  `fetch*`-Methoden geben aktuell `[]` zurück und loggen eine Warnung
  (Ausnahme: TikTok `fetchNewComments` = bewusst dauerhaft `[]`).
- `src/lib/config.ts` — YAML (Struktur) + ENV (Secrets via `${ENV}`), zod-validiert.
- `src/lib/logger.ts` — pino, redigiert `webhookUrl`/Tokens.
- `src/lib/httpClient.ts` — undici-Wrapper (`httpJson`).
- `src/state/store.ts` — better-sqlite3, `seen_events`-Tabelle für Dedup.
- `src/notify/webhook.ts` — POSTet `SocialEvent` (ohne `externalId`) an `WEBHOOK_URL`.
- `src/main.ts` — croner-Loop: pro Provider Posts+Kommentare holen, Dedup, senden.

## Nächste Schritte (für die neue Session)
Einen Adapter nach dem anderen echt implementieren, in dieser Reihenfolge:
1. `linkedin.ts` `fetchNewPosts()` — Token ist vorhanden (`r_organization_social`,
   App „SoloPostics", Client `78s5jdboo592ss`; 60-Tage-Token → Refresh nötig).
2. dann `facebook.ts`, `instagram.ts` (IG-Business-Konto mit FB-Page verknüpfen!).
3. `fetchNewComments()` je Plattform (TikTok überspringen).
4. `fetchStats()` überall + eigenen, selteneren Stats-Job in `main.ts` verdrahten.

Beim Implementieren eines Adapters: neue Events als `SocialEvent` mit stabiler
`externalId` mappen; der Loop übernimmt Dedup und Versand automatisch.

## Konventionen
Node ≥22, pnpm, ESM (Node16), strict TS, vitest, eslint (strict) + prettier
(printWidth 100). Gespiegelt von `status-page-to-chat`. Secrets NIE committen —
Repo ist Open Source (MIT), auch wenn das GitHub-Repo privat ist.

## Verwandte Repos
- `msteams-feeds-automate` — Logic Apps, u. a. `feeds/social` (Teams-Renderer,
  liefert den Contract) und `feeds/social-facebook` (pausierter FB-Webhook-Empfänger).
- `status-page-to-chat` — strukturelles Vorbild.
