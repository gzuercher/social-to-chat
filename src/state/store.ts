import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { PostRef } from "../platforms/types.js";

/** ISO-Zeitstempel des letzten abgeschlossenen Poll-Laufs (metadata-Tabelle). */
export const LAST_RUN_METADATA_KEY = "last_run_at";

/** Posts älter als dieses Fenster werden nicht mehr auf Kommentare geprüft. */
export const COMMENT_WINDOW_DAYS = 30;

/** Posts älter als dieses Fenster fliegen aus der posts-Tabelle. */
const POST_RETENTION_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Persistenter State des Pollers. Drei Aufgaben:
 *
 *   1. **Dedup** (`seen_events`): Ein Event (Post/Kommentar) wird nur einmal
 *      verschickt — seine `externalId` wird nach dem Senden als „gesehen"
 *      gespeichert. Adapter liefern den Bestand im Sichtfenster; ohne diesen
 *      Store würde jeder Poll-Durchlauf alles neu melden.
 *
 *   2. **Post-Registry** (`posts`): Die jüngsten bekannten Posts je Provider,
 *      damit der Loop den Adaptern sagen kann, welche Posts auf Kommentare zu
 *      prüfen sind. Adapter selbst bleiben zustandslos.
 *
 *   3. **Metadata** (`metadata`): Bootstrap-Flags, last_run_at (für den
 *      Docker-HEALTHCHECK), Token-Warn-Zustand.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_events (
        provider_key TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        type         TEXT NOT NULL,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (provider_key, external_id)
      );
      CREATE TABLE IF NOT EXISTS posts (
        provider_key TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        url          TEXT NOT NULL,
        text         TEXT NOT NULL,
        published_at TEXT NOT NULL,
        PRIMARY KEY (provider_key, external_id)
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** True, wenn dieses Event für diesen Provider schon verschickt wurde. */
  hasSeen(providerKey: string, externalId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM seen_events WHERE provider_key = ? AND external_id = ?")
      .get(providerKey, externalId);
    return row !== undefined;
  }

  /** Markiert ein Event als verschickt (bzw. beim Bootstrap: als Bestand). */
  markSeen(providerKey: string, externalId: string, type: string, seenAt: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO seen_events (provider_key, external_id, type, seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(providerKey, externalId, type, seenAt);
  }

  /** Registriert/aktualisiert einen Post in der Post-Registry. */
  upsertPost(providerKey: string, post: PostRef): void {
    this.db
      .prepare(
        `INSERT INTO posts (provider_key, external_id, url, text, published_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_key, external_id) DO UPDATE SET
           url = excluded.url, text = excluded.text, published_at = excluded.published_at`,
      )
      .run(providerKey, post.externalId, post.url, post.text, post.publishedAt);
  }

  /**
   * Die jüngsten bekannten Posts eines Providers innerhalb des
   * Kommentar-Sichtfensters — das ist die Liste, die der Loop dem Adapter
   * für fetchComments() übergibt.
   */
  getRecentPosts(providerKey: string, windowDays = COMMENT_WINDOW_DAYS, limit = 25): PostRef[] {
    const cutoff = new Date(Date.now() - windowDays * MS_PER_DAY).toISOString();
    const rows = this.db
      .prepare(
        `SELECT external_id, url, text, published_at FROM posts
          WHERE provider_key = ? AND published_at >= ?
          ORDER BY published_at DESC LIMIT ?`,
      )
      .all(providerKey, cutoff, limit) as {
      external_id: string;
      url: string;
      text: string;
      published_at: string;
    }[];
    return rows.map((r) => ({
      externalId: r.external_id,
      url: r.url,
      text: r.text,
      publishedAt: r.published_at,
    }));
  }

  /** Entfernt Posts außerhalb des Aufbewahrungsfensters (Hygiene, kein Muss). */
  pruneOldPosts(retentionDays = POST_RETENTION_DAYS): void {
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY).toISOString();
    this.db.prepare("DELETE FROM posts WHERE published_at < ?").run(cutoff);
  }

  /**
   * Bootstrap-Zustand: Beim allerersten Lauf eines Providers wird der
   * Bestand still als gesehen markiert (kein Flood im Chat). Erst wenn das
   * Flag gesetzt ist, wird tatsächlich verschickt.
   */
  isBootstrapped(providerKey: string): boolean {
    return this.getMeta(`bootstrapped:${providerKey}`) !== undefined;
  }

  markBootstrapped(providerKey: string): void {
    this.setMeta(`bootstrapped:${providerKey}`, new Date().toISOString());
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
