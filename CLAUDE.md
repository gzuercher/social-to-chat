# CLAUDE.md — Handoff & Kontext für social-to-chat

Kurzkontext für Claude Code in künftigen Sessions. Das Betriebs-Fundament ist
**fertig und getestet**; die Plattform-Adapter sind bewusst noch Stubs.

## Was das ist
Selbst gehosteter Poller (TypeScript/Node-Container), der die Social-Media-Seiten
der Raptus AG beobachtet und **neue Posts / Kommentare / Statistiken** als JSON
an einen konfigurierbaren Webhook schickt. Bei Raptus zeigt der Webhook auf die
Logic App `social-feed` (Repo `msteams-feeds-automate`), die daraus zentral die
Teams-Adaptive-Card rendert. **Bewusst kein Drittanbieter-SaaS.**

## Familienstandard mit status-page-to-chat (WICHTIG)
Schwester-Projekt: `status-page-to-chat` (lokal: `/home/gzuercher/git-work/status-page-to-chat`,
**dort NIE schreiben** — eigene Session). Entschieden 2026-07-13:

- **Gespiegelte Module** (Header-Kommentar „GESPIEGELTES MODUL"): `lib/healthTracker.ts`
  (dort heißt `hasItems` noch `hasIncidents`), `lib/errorCategory.ts`, `lib/httpClient.ts`.
  Änderungen daran immer in beiden Repos nachziehen (Notiz an die andere Session).
- **Ops-Events**: Health-/Token-Meldungen gehen mit `type: "ops"` durch denselben
  Webhook (Contract-Erweiterung; Rendering muss in `msteams-feeds-automate` noch
  gebaut werden — siehe README-Roadmap).
- **Adapter sind zustandslose Fetcher**: liefern Bestand im Sichtfenster, ungefiltert;
  Dedup/Bootstrap/State zentral (`poller.ts` + `state/store.ts`). `fetchComments(posts)`
  bekommt die jüngsten Posts aus der zentralen Registry übergeben.
- **Erstlauf**: Bestand wird still eingelesen (Bootstrap-Flag), kein Chat-Flood.
- **Token-Watchdog**: `tokenExpiresAt` je Provider in der YAML; warnt T-14/7/1 und
  bei Ablauf (einmal je Stufe, Reset bei neuem Datum). Auto-Refresh = Ausbaustufe 2.

## Prioritäten (Reihenfolge der Umsetzung)
1. **Neue Posts** – alle Plattformen
2. **Kommentare/Fragen** – LinkedIn/Facebook/Instagram (**TikTok ausgeschlossen**)
3. **Statistiken** – alle Plattformen (nur Zahlen; Contract noch undesignt, nicht verdrahtet)
4. (später) Digest

## Architektur (IST)
- `src/platforms/types.ts` — `SocialEvent`, `OpsEvent`, `PostRef`, `SocialProvider`, `Notifier`.
- `src/platforms/{linkedin,facebook,instagram,tiktok}.ts` — **Stubs** mit dokumentierten
  Endpunkten/Scopes (TikTok `fetchComments` = bewusst dauerhaft `[]`).
- `src/poller.ts` — testbarer Poll-Zyklus (Fetch → Post-Registry → Dedup → Versand →
  HealthTracker/Token-Ops → run_summary/last_run_at). Test-Hook: `providerFactory`.
- `src/main.ts` — Entrypoint: croner `protect:true`, Config-Reload je Tick,
  Drain-Shutdown, Subcommands `poll|validate|health`.
- `src/lib/config.ts` — YAML + ENV (`${ENV}`-Platzhalter), zod. ENV-Vorrang:
  `WEBHOOK_URL`, `STATE_DB_PATH` (Name gespiegelt mit sp2c!).
- `src/state/store.ts` — better-sqlite3: `seen_events`, `posts`, `metadata`.
- `src/notify/webhook.ts` — `send()` (strippt `externalId`) + `sendOps()`.
- Docker: `HEALTHCHECK` via `main.js health` (prüft `last_run_at` < 15 min).

## Nächste Schritte
1. `linkedin.ts` `fetchPosts()` — Token vorhanden (`r_organization_social`,
   App „SoloPostics", Client `78s5jdboo592ss`; 60-Tage-Token → `tokenExpiresAt` pflegen!).
2. dann `facebook.ts`, `instagram.ts` (IG-Business-Konto mit FB-Page verknüpfen!).
3. `fetchComments()` je Plattform (TikTok überspringen).
4. `type:"ops"`-Rendering in `msteams-feeds-automate` (Contract siehe README).
5. Stats: erst Contract mit der Logic App designen, dann eigener seltener Job.

Beim Implementieren eines Adapters: `httpGet` aus `lib/httpClient.ts` nutzen
(Timeout/Retry inklusive), Bestand im Sichtfenster liefern, Fehler werfen
(nicht schlucken — der HealthTracker braucht sie), stabile `externalId` mappen.
Der Loop übernimmt Dedup, Bootstrap und Versand automatisch.

## Konventionen
Node ≥22 (lokal: `nvm use 22` — Default ist v20, dann `pnpm rebuild better-sqlite3`),
pnpm, ESM (Node16), strict TS, vitest, eslint (strict) + prettier (printWidth 100).
Secrets NIE committen — Repo ist Open Source (MIT), auch wenn das GitHub-Repo privat ist.

## Verwandte Repos
- `msteams-feeds-automate` — Logic Apps, u. a. `feeds/social` (Teams-Renderer,
  liefert den Contract; braucht noch den `type:"ops"`-Zweig) und
  `feeds/social-facebook` (pausierter FB-Webhook-Empfänger).
- `status-page-to-chat` — Familienstandard-Referenz (gespiegelte Module, read-only!).
