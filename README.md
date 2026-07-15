# Social to Chat

Selbst gehosteter Poller, der die Social-Media-Seiten einer Organisation
(**LinkedIn, Facebook, Instagram, TikTok**) beobachtet und **neue Posts,
Kommentare und Kennzahlen** an einen konfigurierbaren Webhook meldet — z. B. an
eine Logic App, die daraus eine Microsoft-Teams-Karte rendert.

Kein Drittanbieter-SaaS (kein MAKE/n8n): ein kleiner TypeScript/Node-Container,
den man selbst betreibt. Schwester-Projekt von
[status-page-to-chat](https://github.com/raptus-ag/status-page-to-chat).

> **Status:** Funktionsfähig, Live-Verifikation ausstehend. Poll-Loop,
> Deduplizierung, Webhook-Versand, Selbstüberwachung (Health-/Token-Ops-Events
> in den Chat), stiller Erstlauf und Docker-HEALTHCHECK stehen. Alle vier
> Adapter sind implementiert (Posts; Kommentare für LinkedIn/FB/IG) und mit
> Fixture-Tests abgedeckt — **aber noch nicht gegen die echten APIs getestet**
> (Tokens/IDs nötig). Siehe [Roadmap](#roadmap).

## Prioritäten

Umsetzung in dieser Reihenfolge (siehe `src/platforms/types.ts`):

1. **Neue Posts** – alle Plattformen
2. **Kommentare / Fragen** – LinkedIn, Facebook, Instagram (**TikTok ausgeschlossen**, s. u.)
3. **Statistiken** – alle Plattformen (nur Zahlen)

Ein Digest (Zusammenfassung) ist als späteres Feature vorgesehen.

## Plattform-Machbarkeit (Stand 2026-07)

| Plattform | Neue Posts | Kommentare | Statistiken | API |
|---|:---:|:---:|:---:|---|
| LinkedIn | ✅ | ✅ | ✅ | Community Management / Marketing API (`r_organization_social`) |
| Facebook (Page) | ✅ | ✅ | ✅ | Meta Graph API |
| Instagram | ✅ | ✅ | ✅ | Meta Graph API — **IG-Business-Konto, mit FB-Page verknüpft** |
| **TikTok** | ✅ | ❌ | ✅ | Display/Business API — **keine Kommentar-Lese-API** |

TikTok bietet keinen öffentlichen Weg, Kommentare zu lesen (nur die akademische
Research API). Das ist eine Plattform-Beschränkung, kein Umsetzungsproblem —
`TikTokProvider.fetchNewComments()` gibt daher bewusst immer `[]` zurück.

## Contract

Der Poller POSTet je Ereignis dieses JSON an `WEBHOOK_URL` (identisch zum
`social-feed`-Contract im Repo `raptus-integration-router`):

```json
{
  "schemaVersion": 1,
  "source": "social",
  "platform": "linkedin",
  "type": "post",
  "author": "Raptus AG",
  "text": "…",
  "context": "",
  "url": "https://…",
  "timestamp": "2026-07-10T09:30:00Z"
}
```

`platform`/`type` steuern auf der Empfängerseite Icon, Farbe und Texte — der
Poller liefert nur normalisierte Rohdaten.

### Ops-Events (Selbstüberwachung)

Betriebsmeldungen des Pollers gehen als Contract-Erweiterung mit `type: "ops"`
an denselben Webhook — der Chat-Kanal ist zugleich der Alarmkanal:

```json
{
  "schemaVersion": 1,
  "source": "social",
  "type": "ops",
  "kind": "tokenExpiry",
  "platform": "linkedin",
  "provider": "raptus-linkedin",
  "providerName": "Raptus AG (LinkedIn)",
  "daysLeft": 7,
  "message": "Das API-Token für Raptus AG (LinkedIn) läuft in 7 Tagen ab (2026-09-01). Bitte rechtzeitig erneuern.",
  "timestamp": "2026-07-13T09:00:00Z"
}
```

`kind` ∈ `down` | `recovered` | `halfDead` | `tokenExpiry`; bei `down` kommt
`errorCategory` (z. B. `"Authentication failed"`), bei Dauer-bezogenen Meldungen
`durationLabel` (z. B. `"2h 15min"`) mit. Details: [ARCHITECTURE](docs/ARCHITECTURE.md).

## Schnellstart (Entwicklung)

```bash
pnpm install
cp .env.example .env                        # WEBHOOK_URL + Tokens eintragen
cp config/platforms.yaml.example config/platforms.yaml
pnpm build && pnpm start
```

## Betrieb (Container)

```bash
cp .env.example .env                        # Secrets setzen
docker compose up -d
```

Secrets kommen ausschließlich aus Umgebungsvariablen; die YAML enthält nur
`${ENV_NAME}`-Platzhalter. **Keine Tokens committen.**

Nützliche Subcommands (auch im Container):

```bash
node dist/src/main.js validate   # Config prüfen (Exit 0/1)
node dist/src/main.js health     # HEALTHCHECK: letzter Lauf < 15 min?
```

Der Docker-`HEALTHCHECK` nutzt `health` automatisch; beim allerersten Lauf pro
Plattform wird der Bestand **still eingelesen** (kein Post-Flood im Kanal).
Token-Abläufe (`tokenExpiresAt` in der YAML) und anhaltende Adapter-Ausfälle
meldet der Poller selbst als Karte in den Chat.

## Konfiguration

- `config/platforms.yaml` – welche Seiten, wie oft (nicht-geheim). Beispiel:
  `config/platforms.yaml.example`.
- `.env` – Secrets (`WEBHOOK_URL`, `*_ACCESS_TOKEN`). Beispiel: `.env.example`.

## Roadmap

- [x] Betriebs-Härtung: Selbstüberwachung (Ops-Events), Token-Watchdog,
      stiller Erstlauf, HEALTHCHECK, Retry/Backoff (Familienstandard mit
      status-page-to-chat)
- [x] LinkedIn-Adapter: Posts + Kommentare (Fixture-Tests)
- [x] Facebook-Adapter: Posts + Kommentare (Fixture-Tests)
- [x] Instagram-Adapter: Posts + Kommentare (setzt verknüpftes IG-Business-Konto voraus)
- [x] TikTok-Adapter: Posts (keine Kommentare — Plattform-Beschränkung)
- [x] `type: "ops"`-Rendering in der social-feed Logic App
      (`raptus-integration-router`, seit 2026-07-15)
- [ ] **Live-Verifikation aller Adapter mit echten Tokens/IDs** (Feld-Mapping
      bei LinkedIn-Kommentaren ist defensiv, siehe Datei-Header)
- [ ] LinkedIn-Token-Auto-Refresh (Ausbaustufe 2 des Token-Watchdogs);
      TikTok braucht für Produktivbetrieb zwingend einen Refresh-Flow (24-h-Tokens)
- [ ] Stats-Contract designen (Priorität 3, mit raptus-integration-router)
- [ ] Digest / periodische Zusammenfassung
- [ ] GHCR-Image-Publish-Workflow (analog status-page-to-chat)

## Lizenz

[MIT](LICENSE) © 2026 Raptus AG
