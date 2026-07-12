import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Persistenter State für Deduplizierung. Ein Event (Post/Kommentar) wird nur
 * einmal verschickt: seine `externalId` wird nach dem Senden als „gesehen"
 * gespeichert. Ohne diesen Store würde jeder Poll-Durchlauf alles neu melden.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_events (
        provider_key TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        type         TEXT NOT NULL,
        seen_at      TEXT NOT NULL,
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

  /** Markiert ein Event als verschickt. */
  markSeen(providerKey: string, externalId: string, type: string, seenAt: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO seen_events (provider_key, external_id, type, seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(providerKey, externalId, type, seenAt);
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
