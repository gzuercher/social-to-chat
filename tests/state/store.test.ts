import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/state/store.js";
import type { PostRef } from "../../src/platforms/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function post(id: string, ageDays: number): PostRef {
  return {
    externalId: id,
    url: `https://example.com/${id}`,
    text: `Post ${id}`,
    publishedAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
  };
}

describe("Store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function newStore(): Store {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    dirs.push(dir);
    return new Store(join(dir, "test.db"));
  }

  describe("Dedup", () => {
    it("meldet ein Event erst nach markSeen als gesehen", () => {
      const store = newStore();
      expect(store.hasSeen("linkedin", "urn:1")).toBe(false);
      store.markSeen("linkedin", "urn:1", "post", new Date().toISOString());
      expect(store.hasSeen("linkedin", "urn:1")).toBe(true);
      store.close();
    });

    it("trennt State pro Provider-Key", () => {
      const store = newStore();
      store.markSeen("linkedin", "id", "post", new Date().toISOString());
      expect(store.hasSeen("facebook", "id")).toBe(false);
      store.close();
    });
  });

  describe("Post-Registry", () => {
    it("liefert nur Posts im Sichtfenster, jüngste zuerst", () => {
      const store = newStore();
      store.upsertPost("li", post("old", 45)); // ausserhalb 30-Tage-Fenster
      store.upsertPost("li", post("mid", 10));
      store.upsertPost("li", post("new", 1));
      const recent = store.getRecentPosts("li");
      expect(recent.map((p) => p.externalId)).toEqual(["new", "mid"]);
      store.close();
    });

    it("respektiert das Limit und trennt Provider", () => {
      const store = newStore();
      for (let i = 0; i < 30; i++) store.upsertPost("li", post(`p${i}`, i % 20));
      store.upsertPost("fb", post("other", 1));
      expect(store.getRecentPosts("li", 30, 5)).toHaveLength(5);
      expect(store.getRecentPosts("fb").map((p) => p.externalId)).toEqual(["other"]);
      store.close();
    });

    it("upsert aktualisiert bestehende Posts statt zu duplizieren", () => {
      const store = newStore();
      store.upsertPost("li", post("a", 2));
      store.upsertPost("li", { ...post("a", 2), text: "aktualisiert" });
      const recent = store.getRecentPosts("li");
      expect(recent).toHaveLength(1);
      expect(recent[0].text).toBe("aktualisiert");
      store.close();
    });

    it("pruneOldPosts entfernt Posts ausserhalb der Aufbewahrung", () => {
      const store = newStore();
      store.upsertPost("li", post("ancient", 200));
      store.upsertPost("li", post("fresh", 1));
      store.pruneOldPosts(180);
      // ancient ist weg — auch mit grosszügigem Fenster nicht mehr auffindbar
      expect(store.getRecentPosts("li", 365).map((p) => p.externalId)).toEqual(["fresh"]);
      store.close();
    });
  });

  describe("Bootstrap-Flag", () => {
    it("ist anfangs false und nach markBootstrapped true", () => {
      const store = newStore();
      expect(store.isBootstrapped("li")).toBe(false);
      store.markBootstrapped("li");
      expect(store.isBootstrapped("li")).toBe(true);
      expect(store.isBootstrapped("fb")).toBe(false);
      store.close();
    });
  });

  describe("Metadata", () => {
    it("setzt und überschreibt Werte", () => {
      const store = newStore();
      expect(store.getMeta("k")).toBeUndefined();
      store.setMeta("k", "v1");
      store.setMeta("k", "v2");
      expect(store.getMeta("k")).toBe("v2");
      store.close();
    });
  });
});
