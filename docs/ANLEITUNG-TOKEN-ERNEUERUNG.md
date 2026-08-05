# Anleitung: Social-Media-Anbindung einrichten und Schlüssel erneuern

*Diese Anleitung ist bewusst für Personen ohne Technik-Hintergrund geschrieben.
Zeitbedarf: ca. 10 Minuten.*

## Worum geht es?

Ein kleines Programm („der Poller") beobachtet die Social-Media-Seiten der
Firma und meldet neue Beiträge und Kommentare automatisch im Teams-Kanal
**Social Media**. Damit das funktioniert, braucht es digitale Schlüssel
(„Tokens") zu LinkedIn, Facebook/Instagram und TikTok.

**Der LinkedIn-Schlüssel läuft einmal pro Jahr ab** und muss dann von einem
Menschen erneuert werden — das geht nicht automatisch, LinkedIn verlangt
eine persönliche Anmeldung. Genau dafür gibt es den **Einrichtungs-
Assistenten**: eine Webseite, die dich durch alle Schritte führt.

## Wann muss ich das tun?

Du musst nichts überwachen — **das System meldet sich selbst**: Im
Teams-Kanal *Social Media* erscheint eine gelbe Karte
**„🛠️ SOCIAL MEDIA · OPS"** mit einem Text wie:

> *„Der Refresh-Token für Raptus AG (LinkedIn) läuft in 14 Tagen ab — bitte
> einmalig neu autorisieren."*

Die Karte kommt bei 14, 7 und 1 Tag Restzeit. Sobald du diese Anleitung
durchgeführt hast, hören die Warnungen auf.

## Was du brauchst

| Was | Wo |
|---|---|
| Zugang zum Assistenten (Benutzer `setup` + Passwort) | Passwortmanager, Eintrag **„Social-Wizard"** |
| Ein LinkedIn-Konto, das **Admin der Firmen-Seite** ist | dein persönliches LinkedIn-Login |
| Jemanden mit Server-Zugang für Schritt 1 und 5 (zwei Befehle) | IT / Admin — oder du selbst per Copy-Paste |

---

## Schritt 1 — Assistent einschalten

Der Assistent läuft aus Sicherheitsgründen nicht dauerhaft. Er wird mit
einem Befehl auf dem Server eingeschaltet (IT fragen oder selbst per
SSH-Terminal einloggen und einfügen):

```bash
cd /opt/stacks/raptus-social-notifs && docker compose --profile setup up -d setup
```

✅ *Erwartung:* Der Befehl endet nach wenigen Sekunden ohne Fehlermeldung.

## Schritt 2 — Assistent im Browser öffnen

1. Öffne im Browser: **https://social-notifs-setup.raptus.com**
2. Es erscheint ein Anmeldefenster: Benutzer **`setup`**, Passwort aus dem
   Passwortmanager (Eintrag „Social-Wizard").

✅ *Erwartung:* Eine Seite mit dem Titel **„Einrichtung"** und einer Liste
der Plattformen (LinkedIn, Facebook/Instagram, TikTok) mit Häkchen.

> ❌ *„502" oder Seite lädt nicht?* → Der Assistent ist nicht eingeschaltet,
> zurück zu Schritt 1.

## Schritt 3 — LinkedIn erneuern (der Hauptteil)

1. Klicke oben auf **„LinkedIn"**.
2. Die Felder *Client-ID* und *Client-Secret* sind normalerweise **schon
   ausgefüllt** — nichts ändern.
3. Klicke auf **„Bei LinkedIn anmelden & autorisieren →"**.
4. Du landest bei LinkedIn: Melde dich mit deinem **persönlichen**
   LinkedIn-Konto an (es muss Admin der Firmen-Seite sein) und bestätige
   mit **„Zulassen"**.
5. Du kommst automatisch zum Assistenten zurück. Dort steht:
   ✅ *„Token erhalten (inkl. Refresh-Token — Auto-Refresh aktiv)"*.
6. Die Firmen-Organisation ist bereits vorausgewählt — einfach auf
   **„Speichern → .env + platforms.yaml"** klicken.

✅ *Erwartung:* Zurück auf der Übersicht; bei LinkedIn ist ein ✅ und unten
steht *„Konfiguration gültig"*.

> ❌ *„Kein Refresh-Token in der Antwort"?* → Mit dieser Meldung bitte an
> die IT — das ist eine Einstellung der LinkedIn-App, kein Bedienfehler.

## Schritt 4 — Nur bei Ersteinrichtung: Facebook/Instagram und TikTok

*Bei der jährlichen LinkedIn-Erneuerung überspringst du diesen Schritt.*

- **Facebook/Instagram**: Seite „Facebook/Instagram" → den von der IT
  erstellten *System-User-Token* einfügen → der Assistent findet die
  Firmen-Seite und das Instagram-Konto selbst → auswählen → Speichern.
  Dieser Schlüssel **läuft nie ab** — einmal einrichten, nie wieder.
  *(Findet der Assistent keine Seite, fehlt beim Token ein Häkchen oder dem
  Systemnutzer die Seiten-Zuweisung — die Meldung sagt es, Details für die
  IT in [TOKENS.md](TOKENS.md).)*
- **TikTok**: Seite „TikTok" → drei Werte einfügen (kommen von der IT aus
  dem TikTok-Developer-Portal) → der Assistent prüft sie sofort → Speichern.

## Schritt 5 — Assistent ausschalten und Poller neu starten

Wieder ein Befehl auf dem Server (IT oder Copy-Paste):

```bash
cd /opt/stacks/raptus-social-notifs && docker compose restart raptus-social-notifs && docker compose --profile setup down
```

✅ *Erwartung:* Endet ohne Fehlermeldung. Der Assistent ist danach
absichtlich nicht mehr erreichbar.

## Schritt 6 — Kontrolle

- Innerhalb von ca. 10 Minuten darf **keine neue gelbe Warn-Karte** im
  Teams-Kanal erscheinen.
- Fertig! Neue Posts und Kommentare erscheinen ab jetzt wieder automatisch.

---

## Wenn etwas nicht klappt

| Symptom | Ursache / Lösung |
|---|---|
| Anmeldefenster akzeptiert das Passwort nicht | Passwortmanager-Eintrag „Social-Wizard" prüfen; sonst IT (Passwort liegt gehasht in der Caddy-Konfiguration) |
| „502 Bad Gateway" | Assistent nicht eingeschaltet → Schritt 1 |
| LinkedIn sagt „Redirect URI mismatch" | Einstellung der LinkedIn-App → IT (Redirect-URL muss `https://social-notifs-setup.raptus.com/callback/linkedin` sein) |
| Nach dem Speichern steht „Konfiguration nicht gültig" | Screenshot machen → IT |
| Warn-Karten kommen trotzdem weiter | Schritt 5 vergessen (Poller-Neustart)? Sonst IT mit Screenshot der Karte |

**Für die IT:** Technischer Hintergrund in [TOKENS.md](TOKENS.md) und
[ARCHITECTURE.md](ARCHITECTURE.md); der Stack liegt in
`/opt/stacks/raptus-social-notifs`, Logs via
`docker logs raptus-social-notifs`.
