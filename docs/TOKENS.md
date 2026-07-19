# Token-Management — maximale Automatisierung

Ziel: **einmalige menschliche Einrichtung pro Plattform, danach null manuelle
Schritte.** Dieses Dokument listet ehrlich auf, was automatisch läuft und wo
zwingend ein Mensch ran muss.

> **Für Nicht-Techniker:** Die Schritt-für-Schritt-Bedienungsanleitung
> (jährliche LinkedIn-Erneuerung, Ersteinrichtung) steht in
> [ANLEITUNG-TOKEN-ERNEUERUNG.md](ANLEITUNG-TOKEN-ERNEUERUNG.md).
> Dieses Dokument hier ist die technische Referenz.

## Der empfohlene Weg: Setup-Wizard

Für die Einrichtung (und den jährlichen LinkedIn-Re-Consent) gibt es ein
geführtes Web-Interface — keine curl-Befehle, kein Code-Kopieren:

```bash
# lokal auf dem Server:
node dist/src/main.js setup
# vom Arbeitsplatz aus erreichbar machen:
ssh -L 8911:localhost:8911 <server>     # dann http://localhost:8911 öffnen
```

Der Wizard bindet **nur an localhost**, führt pro Plattform durch die Schritte,
validiert Tokens sofort gegen die echten APIs, entdeckt Organisation-URN /
Page-ID / IG-User-ID automatisch und schreibt `.env` + `config/platforms.yaml`.
Einzige Einmal-Vorarbeit: die Redirect-URL `http://localhost:8911/callback/linkedin`
in der LinkedIn-App registrieren (der Wizard zeigt sie an).

Die folgenden Abschnitte erklären die Hintergründe und dienen als Referenz,
falls man den Weg manuell gehen will oder der Wizard nicht verfügbar ist.

## Übersicht

| Plattform | Automatisierungsgrad | Menschliche Schritte |
|---|---|---|
| LinkedIn | Auto-Refresh (Access 60 d) | Einmalig OAuth-Consent; **Re-Consent nach max. 365 d** (Refresh-Token-Laufzeit) — Ops-Karte warnt bei T-14/7/1 |
| TikTok | Auto-Refresh (Access 24 h, Refresh rotiert) | Einmalig OAuth-Consent; danach praktisch unbegrenzt, solange der Poller läuft |
| Facebook | Kein Refresh-Flow der API | Einmalig **System-User-Token** erstellen (läuft nie ab) → danach nichts mehr |
| Instagram | wie Facebook (läuft über die verknüpfte Page) | wie Facebook |

Der Poller erneuert Access-Tokens **selbst** (Modul `src/lib/tokenRefresh.ts`):
Zustand inkl. rotierter Refresh-Tokens liegt in der SQLite-Metadata und
überlebt Neustarts; die Adapter lesen weiterhin nur ihre `tokenEnv`.

## LinkedIn

**Einmalig (Mensch):**
1. In der LinkedIn-App („SoloPostics", Client `78s5jdboo592ss`) sicherstellen,
   dass „Refresh Tokens" verfügbar sind (Community-Management-/Marketing-
   Freigabe der App).
2. OAuth-Authorization-Code-Flow einmal durchlaufen (Scope
   `r_organization_social`): Browser-Consent → `code` → gegen
   `https://www.linkedin.com/oauth/v2/accessToken` tauschen. Ergebnis:
   `access_token` (60 d) **und** `refresh_token` (365 d).
3. In `.env` eintragen: `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_REFRESH_TOKEN`,
   `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.
4. In `config/platforms.yaml` den `refresh:`-Block aktivieren
   (siehe `platforms.yaml.example`). `tokenExpiresAt` dann weglassen.

**Danach automatisch:** Der Poller erneuert den Access-Token, sobald weniger
als 7 Tage Restlaufzeit bleiben. Liefert LinkedIn ein rotiertes Refresh-Token,
wird es übernommen.

**Verbleibende menschliche Pflicht:** Der Refresh-Token selbst läuft nach
spätestens 365 Tagen ab und kann **nicht** programmatisch verlängert werden —
dann Schritt 2–3 wiederholen (neuen Refresh-Token in `.env` eintragen; der
Poller erkennt den geänderten ENV-Wert und übernimmt automatisch). Die
Ops-Karte im Teams-Kanal warnt 14/7/1 Tage vorher.

## TikTok

**Einmalig (Mensch):**
1. TikTok-Developer-App mit Scope `video.list`; Login-Kit-Consent-Flow einmal
   durchlaufen → `access_token` (24 h) + `refresh_token` (365 d).
2. In `.env`: `TIKTOK_ACCESS_TOKEN`, `TIKTOK_REFRESH_TOKEN`,
   `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.
3. `refresh:`-Block in der YAML aktivieren (Hinweis: `clientIdEnv` zeigt bei
   TikTok auf den **client_key**).

**Danach automatisch:** Access-Token wird laufend erneuert (Margin 2 h).
TikTok **rotiert den Refresh-Token bei jedem Refresh mit** — der Poller
übernimmt ihn in seinen Store. Solange der Poller regelmäßig läuft, ist damit
kein menschlicher Eingriff mehr nötig. Steht der Poller länger als die
Refresh-Token-Laufzeit still, ist ein Re-Consent fällig (Ops-Warnung kommt,
solange er noch läuft).

## Facebook & Instagram

Meta bietet **keinen Refresh-Token-Mechanismus**. Der Weg zu null manuellen
Schritten ist ein anderer:

**Empfohlen — System-User-Token (läuft nie ab):**
1. Im Meta Business Manager einen **System User** (Typ Admin oder Employee)
   anlegen.
2. Der Page (und dem verknüpften IG-Business-Konto) als Asset zuweisen.
3. Token generieren mit Scopes `pages_read_engagement`,
   `pages_read_user_content`, `instagram_basic`, `instagram_manage_comments`
   — **ohne Ablauf** („Never expires" wählen).
4. In `.env` als `FACEBOOK_PAGE_TOKEN` / `INSTAGRAM_ACCESS_TOKEN` eintragen.
   Kein `tokenExpiresAt`, kein `refresh:`-Block nötig. Fertig — dauerhaft.

**Fallback — long-lived User/Page-Token:** ~60 Tage gültig; dann
`tokenExpiresAt` in der YAML pflegen, der statische Watchdog warnt bei
T-14/7/1. Manuelles Erneuern alle 2 Monate — nicht empfohlen.

Hinweis: Auch „nie ablaufende" Meta-Tokens werden invalidiert, wenn der
System User gelöscht wird, das Passwort-/Sicherheitsereignis eintritt oder
Scopes entzogen werden. Das fängt die 401-Erkennung ab: der Adapter meldet
nach dem Down-Schwellwert „Authentication failed" als Ops-Karte.

## Sicherheitsregeln

- Client-Secrets und Tokens **nur** in `.env` / Container-ENV — nie in YAML
  oder Git (Repo ist Open Source).
- Der Token-Zustand in der SQLite-DB (`/data`-Volume) enthält Tokens im
  Klartext — das Volume entsprechend schützen (kein Backup in unsichere Ziele).
- `LOG_LEVEL=debug` loggt URLs, aber nie Tokens (Logger redigiert, Tokens
  stehen in Headern/Bodies, nicht in URLs).
