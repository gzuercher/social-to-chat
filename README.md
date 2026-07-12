# Social to Chat

Selbst gehosteter Poller, der die Social-Media-Seiten einer Organisation
(**LinkedIn, Facebook, Instagram, TikTok**) beobachtet und **neue Posts,
Kommentare und Kennzahlen** an einen konfigurierbaren Webhook meldet — z. B. an
eine Logic App, die daraus eine Microsoft-Teams-Karte rendert.

Kein Drittanbieter-SaaS (kein MAKE/n8n): ein kleiner TypeScript/Node-Container,
den man selbst betreibt. Schwester-Projekt von
[status-page-to-chat](https://github.com/raptus-ag/status-page-to-chat).

> **Status:** Grundgerüst. Das Datenmodell, der Poll-Loop, Deduplizierung und
> der Webhook-Versand stehen; die Plattform-Adapter sind Stubs mit dokumentierten
> API-Endpunkten und `TODO`s. Siehe [Roadmap](#roadmap).

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
`social-feed`-Contract im Repo `msteams-feeds-automate`):

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

## Konfiguration

- `config/platforms.yaml` – welche Seiten, wie oft (nicht-geheim). Beispiel:
  `config/platforms.yaml.example`.
- `.env` – Secrets (`WEBHOOK_URL`, `*_ACCESS_TOKEN`). Beispiel: `.env.example`.

## Roadmap

- [ ] LinkedIn-Adapter: Posts → Kommentare → Stats
- [ ] Facebook-Adapter: Posts → Kommentare → Stats
- [ ] Instagram-Adapter (setzt verknüpftes IG-Business-Konto voraus)
- [ ] TikTok-Adapter: Posts + Stats (keine Kommentare)
- [ ] Digest / periodische Zusammenfassung
- [ ] GHCR-Image-Publish-Workflow (analog status-page-to-chat)

## Lizenz

[MIT](LICENSE) © 2026 Raptus AG
