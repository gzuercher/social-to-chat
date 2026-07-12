/**
 * Kernmodell von social-to-chat.
 *
 * Ein Plattform-Adapter liefert normalisierte {@link SocialEvent}s (neue Posts
 * und Kommentare) sowie optional {@link SocialStats}. Das Event-Format ist
 * bewusst identisch zum Contract, den die Teams-Renderer-Logic-App `social-feed`
 * (Repo msteams-feeds-automate) erwartet — der Notifier schickt es unverändert
 * an einen konfigurierbaren Webhook.
 *
 * Prioritäten (in dieser Reihenfolge umsetzen):
 *   1. fetchNewPosts()    — neue Beiträge (alle Plattformen)
 *   2. fetchNewComments() — Kommentare/Fragen (LinkedIn/Facebook/Instagram)
 *   3. fetchStats()       — Kennzahlen pro Post (alle Plattformen)
 */

export type Platform = "linkedin" | "facebook" | "instagram" | "tiktok";

export type SocialEventType = "post" | "comment";

/** Neuer Post oder Kommentar, normalisiert. Entspricht dem social-feed-Contract. */
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

/** Kennzahlen eines Posts (Priorität 3). TikTok: nur Zahlen, kein Kommentar-Text. */
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
 */
export interface SocialProvider {
  /** Eindeutiger Config-Key (z.B. "raptus-linkedin"). */
  readonly key: string;
  readonly platform: Platform;

  /** Priorität 1: neue Beiträge seit dem letzten Lauf. */
  fetchNewPosts(): Promise<SocialEvent[]>;

  /** Priorität 2: neue Kommentare seit dem letzten Lauf. TikTok liefert immer []. */
  fetchNewComments(): Promise<SocialEvent[]>;

  /** Priorität 3 (optional): Kennzahlen zu gegebenen Post-IDs. */
  fetchStats?(externalIds: string[]): Promise<SocialStats[]>;
}

/** Ausgabeziel: verschickt SocialEvents (z.B. an den social-feed-Webhook). */
export interface Notifier {
  send(event: SocialEvent): Promise<void>;
}
