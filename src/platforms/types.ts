/**
 * Kernmodell von social-to-chat.
 *
 * Ein Plattform-Adapter liefert normalisierte {@link SocialEvent}s (Posts und
 * Kommentare) sowie optional {@link SocialStats}. Das Event-Format ist bewusst
 * identisch zum Contract, den die Teams-Renderer-Logic-App `social-feed`
 * (Repo msteams-feeds-automate) erwartet — der Notifier schickt es unverändert
 * an einen konfigurierbaren Webhook.
 *
 * Architektur-Prinzip (Familienstandard mit status-page-to-chat):
 * **Adapter sind zustandslose Fetcher.** Sie liefern den aktuellen Bestand im
 * Sichtfenster, ungefiltert; Deduplizierung, Bootstrap und aller persistente
 * Zustand leben zentral im Loop/Store. Adapter fassen den Store nie an —
 * dadurch bleiben sie mit Fixtures testbar.
 *
 * Prioritäten (in dieser Reihenfolge umsetzen):
 *   1. fetchPosts()    — Beiträge (alle Plattformen)
 *   2. fetchComments() — Kommentare/Fragen (LinkedIn/Facebook/Instagram)
 *   3. fetchStats()    — Kennzahlen pro Post (alle Plattformen; Contract noch undesignt)
 */

export type Platform = "linkedin" | "facebook" | "instagram" | "tiktok";

export type SocialEventType = "post" | "comment";

/** Post oder Kommentar, normalisiert. Entspricht dem social-feed-Contract. */
export interface SocialEvent {
  schemaVersion: 1;
  source: "social";
  platform: Platform;
  type: SocialEventType;
  /** Stabile ID zur Deduplizierung (Post-URN / Kommentar-ID). Nicht im Contract, nur intern. */
  externalId: string;
  /** Seite/Autor bei Post, Kommentator bei Kommentar. */
  author: string;
  /** Post- bzw. Kommentartext. */
  text: string;
  /** Bei Kommentaren: Titel/Auszug des Eltern-Posts; bei Posts leer. */
  context: string;
  /** Link zum Post/Kommentar (für „Öffnen & Liken"). */
  url: string;
  /** ISO 8601. */
  timestamp: string;
}

/**
 * Betriebs-/Health-Meldung des Pollers selbst. Geht als Contract-Erweiterung
 * mit `type: "ops"` an denselben Webhook wie die SocialEvents — die
 * social-feed Logic App rendert daraus eine schlichte Warn-/Info-Karte.
 * Der Teams-Kanal ist damit zugleich der Alarmkanal des Pollers
 * (kein separates Monitoring nötig).
 */
export type OpsKind = "down" | "recovered" | "halfDead" | "tokenExpiry";

export interface OpsEvent {
  schemaVersion: 1;
  source: "social";
  type: "ops";
  kind: OpsKind;
  platform: Platform;
  /** Config-Key des betroffenen Providers (z. B. "raptus-linkedin"). */
  provider: string;
  /** Menschlicher Name (aus der Config, fürs Rendering). */
  providerName: string;
  /** Fertig formulierter Kurztext für die Karte. */
  message: string;
  /** Bei kind "down": Fehlerkategorie (z. B. "Authentication failed"). */
  errorCategory?: string;
  /** Bei down/recovered/halfDead: menschliche Dauer (z. B. "2h 15min"). */
  durationLabel?: string;
  /** Bei kind "tokenExpiry": Resttage (0 = abgelaufen). */
  daysLeft?: number;
  /** ISO 8601. */
  timestamp: string;
}

/**
 * Referenz auf einen bekannten Post, die der Loop den Adaptern für die
 * Kommentar-Abfrage übergibt. Stammt aus der zentralen `posts`-Tabelle.
 */
export interface PostRef {
  externalId: string;
  url: string;
  /** Textauszug des Posts — dient Adaptern als `context` der Kommentare. */
  text: string;
  /** ISO 8601. */
  publishedAt: string;
}

/** Kennzahlen eines Posts (Priorität 3 — Contract noch undesignt, nicht verdrahtet). */
export interface SocialStats {
  platform: Platform;
  externalId: string;
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
  fetchedAt: string;
}

/**
 * Ein Adapter je Plattform. Neue Plattform hinzufügen = neue Datei, die dies
 * implementiert, + Registrierung in platforms/index.ts + Eintrag in der Config.
 *
 * Wichtig: Alle fetch*-Methoden liefern den Bestand im Sichtfenster,
 * NICHT nur „neue" Einträge — was neu ist, entscheidet der Loop (Dedup).
 * Fehler werfen, nicht schlucken: der Loop kategorisiert sie und der
 * HealthTracker meldet anhaltende Ausfälle in den Chat.
 */
export interface SocialProvider {
  /** Eindeutiger Config-Key (z.B. "raptus-linkedin"). */
  readonly key: string;
  readonly platform: Platform;

  /** Priorität 1: Beiträge im Sichtfenster (z. B. die letzten 30 Tage). */
  fetchPosts(): Promise<SocialEvent[]>;

  /**
   * Priorität 2: Kommentare zu den übergebenen Posts. Der Loop übergibt die
   * jüngsten bekannten Posts aus dem Store. TikTok liefert immer [].
   */
  fetchComments(posts: PostRef[]): Promise<SocialEvent[]>;

  /** Priorität 3 (geparkt): Kennzahlen zu gegebenen Post-IDs. */
  fetchStats?(externalIds: string[]): Promise<SocialStats[]>;
}

/** Ausgabeziel: verschickt Social- und Ops-Events (z.B. an den social-feed-Webhook). */
export interface Notifier {
  send(event: SocialEvent): Promise<void>;
  sendOps(event: OpsEvent): Promise<void>;
}
