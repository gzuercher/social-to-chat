import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store.js";

describe("Store dedup", () => {
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
