# CLAUDE.md — Handoff & Kontext für social-to-chat

Kurzkontext für Claude Code in künftigen Sessions. Betriebs-Fundament UND alle
vier Adapter sind **implementiert und fixture-getestet** — die Adapter sind
aber **noch nicht gegen die echten APIs verifiziert** (Tokens/IDs nötig).

## Was das ist
Selbst gehosteter Poller (TypeScript/Node-Container), der die Social-Media-Seiten
der Raptus AG beobachtet und **neue Posts / Kommentare / Statistiken** als JSON
an einen konfigurierbaren Webhook schickt. Bei Raptus zeigt der Webhook auf die
Logic App `social-feed` (Repo `raptus-integration-router`, ehemals
`msteams-feeds-automate`), die daraus zentral die
Teams-Adaptive-Card rendert. **Bewusst kein Drittanbieter-SaaS.**

## Familienstandard mit status-page-to-chat (WICHTIG)
Schwester-Projekt: `status-page-to-chat` (lokal: `/home/gzuercher/git-work/status-page-to-chat`,
**dort NIE schreiben** — eigene Session). Entschieden 2026-07-13:

- **Gespiegelte Module** (Header-Kommentar „GESPIEGELTES MODUL"): `lib/healthTracker.ts`
  (dort heißt `hasItems` noch `hasIncidents`), `lib/errorCategory.ts`, `lib/httpClient.ts`.
  Änderungen daran immer in beiden Repos nachziehen (Notiz an die andere Session).
- **Ops-Events**: Health-/Token-Meldungen gehen mit `type: "ops"` durch denselben
  Webhook (Contract-Erweiterung; Rendering in `raptus-integration-router` ist
  seit 2026-07-15 gebaut).
- **Adapter sind zustandslose Fetcher**: liefern Bestand im Sichtfenster, ungefiltert;
  Dedup/Bootstrap/State zentral (`poller.ts` + `state/store.ts`). `fetchComments(posts)`
  bekommt die jüngsten Posts aus der zentralen Registry übergeben.
- **Erstlauf**: Bestand wird still eingelesen (Bootstrap-Flag), kein Chat-Flood.
- **Token-Management**: Auto-Refresh für LinkedIn/TikTok (`lib/tokenRefresh.ts`,
  `options.refresh` in der YAML; Zustand inkl. rotierter Refresh-Tokens in der
  Store-Metadata, injiziert Access-Tokens in die tokenEnv). Statischer Watchdog
  (`tokenExpiresAt`, T-14/7/1) nur noch für Provider ohne Refresh (z. B. Meta-
  Fallback; empfohlen dort: System-User-Token, läuft nie ab). Manuelle
  Einmal-Schritte je Plattform: docs/TOKENS.md.

## Prioritäten (Reihenfolge der Umsetzung)
1. **Neue Posts** – alle Plattformen
2. **Kommentare/Fragen** – LinkedIn/Facebook/Instagram (**TikTok ausgeschlossen**)
3. **Statistiken** – alle Plattformen (nur Zahlen; Contract noch undesignt, nicht verdrahtet)
4. (später) Digest

## Architektur (IST)
- `src/platforms/types.ts` — `SocialEvent`, `OpsEvent`, `PostRef`, `SocialProvider`, `Notifier`.
- `src/platforms/{linkedin,facebook,instagram,tiktok}.ts` — implementierte Adapter
  (fixture-getestet, Live-Verifikation offen; TikTok `fetchComments` = bewusst
  dauerhaft `[]`). Options-Validierung per zod im Konstruktor.
- `src/poller.ts` — testbarer Poll-Zyklus (Fetch → Post-Registry → Dedup → Versand →
  HealthTracker/Token-Ops → run_summary/last_run_at). Test-Hook: `providerFactory`.
- `src/main.ts` — Entrypoint: croner `protect:true`, Config-Reload je Tick,
  Drain-Shutdown, Subcommands `poll|validate|health`.
- `src/lib/config.ts` — YAML + ENV (`${ENV}`-Platzhalter), zod. ENV-Vorrang:
  `WEBHOOK_URL`, `STATE_DB_PATH` (Name gespiegelt mit sp2c!).
- `src/state/store.ts` — better-sqlite3: `seen_events`, `posts`, `metadata`.
- `src/notify/webhook.ts` — `send()` (strippt `externalId`) + `sendOps()`.
- Docker: `HEALTHCHECK` via `main.js health` (prüft `last_run_at` < 15 min).
- `src/cli/setup.ts` — **Setup-Wizard** (`main.js setup`): localhost-Web-UI für
  Token-Einrichtung/Re-Consent. LinkedIn-OAuth-Flow (Wizard = Redirect-URI,
  Org-URN-Discovery), Meta me/accounts-Discovery (Page-Token/IG-ID), TikTok-
  Paste-Modus mit sofortiger Refresh-Validierung (Rotation!). Schreibt `.env`
  (`lib/envFile.ts`) und `platforms.yaml` kommentar-erhaltend (`lib/yamlConfig.ts`).
  main.ts lädt die `.env` selbst (Container-ENV hat Vorrang).

Meta-Seite: Im Business-Portfolio der Raptus AG existiert die interne App
**„Social-to-Chat-Internal"** (App-ID 1591886198962675) — sie ist der
App-Kontext für den System-User-Token (Meta vergibt Tokens nur app-gebunden).

## Live-Stand (2026-08-06)
- **LinkedIn Posts: verifiziert ✅** (Org `urn:li:organization:2127937`, Feld-Mapping
  id/commentary/publishedAt bestätigt). Läuft produktiv im Stack
  `/opt/stacks/raptus-social-notifs` (Container `raptus-social-notifs`).
  **Der Server ist die lokale Maschine dieser Session — kein SSH nötig**,
  `docker exec raptus-social-notifs …` genügt.
  Image: lokal gebaut (`social-to-chat:local`, keine Registry) — Update- und
  Rückfall-Ablauf: README, Abschnitt „Produktiv-Image".
- **LinkedIn Auto-Refresh: verifiziert ✅** — Metadata `oauthToken:raptus-linkedin`
  enthält einen selbst geholten Access-Token (≠ Seed aus der `.env`),
  Access bis 2026-09-20, Refresh bis **2027-07-19** (dann Re-Consent).
  LinkedIn ist damit abgeschlossen; die App heisst **„Social-Feed"**.
- **LinkedIn Kommentare: aufgegeben ⚠️** — `/rest/socialActions/…` braucht die
  Community Management API (`403 partnerApiSocialActions`). Bewusst **nicht**
  beantragt: nur für kommerzielle Use-Cases, eine Ablehnung verbrennt die App
  (kein erneuter Antrag mit derselben App), und Dev-Tier hat 500 Calls/24 h.
  Begründung: docs/TOKENS.md. `comments: false` bleibt.
- **API-Version**: nicht mehr gepinnt — Default ist der Vormonat
  (`defaultApiVersion()`), sonst bricht der Adapter jährlich mit `426`.
- Meta/TikTok: Tokens noch nicht eingerichtet.

## Nächste Schritte
1. **Live-Verifikation der Adapter** mit echten Tokens/IDs (LinkedIn ist erledigt):
   Facebook, dann Instagram (IG-Business-Konto mit FB-Page verknüpfen!), dann TikTok.
2. Token-Einrichtung je Plattform (einmalige menschliche Schritte, docs/TOKENS.md):
   Meta System-User-Token, TikTok OAuth-Consent für den Auto-Refresh.
3. **Erinnerungs-Mail** für manuelle Erneuerungen (Guys ausdrückliche Anforderung:
   Kalendereintrag von Hand ist keine Lösung). Die Ops-Events `kind:"tokenExpiry"`
   existieren; der Mailversand gehört in die Logic App `social-feed`
   (`raptus-integration-router`, Office-365-Connector) — kein SMTP im Poller.
4. Stats (P3): erst Contract mit der Logic App designen, dann eigener seltener Job.

Spiegel-Hinweis für status-page-to-chat: `httpClient.httpPost` akzeptiert jetzt
auch String-Payloads (form-encodierte Bodies, für OAuth) — beim nächsten
Modul-Abgleich mitnehmen.

Der social-Contract (inkl. `type:"ops"`, seit 2026-07-15 dort gerendert) lebt
als Quelle der Wahrheit in `raptus-integration-router` — nach Contract-
Änderungen beidseitig abgleichen.

Adapter-Regeln (für Änderungen/neue Plattformen): `httpGet`/`httpPost` aus
`lib/httpClient.ts` nutzen (Timeout/Retry inklusive), Bestand im Sichtfenster
liefern, Fehler werfen (nicht schlucken — der HealthTracker braucht sie),
stabile `externalId` mappen, options per zod im Konstruktor validieren.
Der Loop übernimmt Dedup, Bootstrap und Versand automatisch.

## Konventionen
Node ≥22 (lokal: `nvm use 22` — Default ist v20, dann `pnpm rebuild better-sqlite3`),
pnpm, ESM (Node16), strict TS, vitest, eslint (strict) + prettier (printWidth 100).
Secrets NIE committen — Repo ist Open Source (MIT), auch wenn das GitHub-Repo privat ist.

## Verwandte Repos
- `raptus-integration-router` (ehemals `msteams-feeds-automate`) — Logic Apps,
  u. a. `feeds/social` (Teams-Renderer, liefert den Contract; rendert seit
  2026-07-15 auch `type:"ops"`) und `feeds/social-facebook` (pausierter
  FB-Webhook-Empfänger).
- `status-page-to-chat` — Familienstandard-Referenz (gespiegelte Module, read-only!).
