import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/state/store.js";
import { checkTokenExpiry } from "../../src/lib/tokenWatchdog.js";
import type { PlatformConfig } from "../../src/lib/config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function provider(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    key: "raptus-linkedin",
    platform: "linkedin",
    name: "Raptus AG (LinkedIn)",
    enabled: true,
    options: {},
    ...overrides,
  };
}

/** now-Funktion, die `daysLeft` Tage vor dem Ablaufdatum liegt. */
function nowBefore(expiresAt: string, days: number): () => number {
  return () => Date.parse(`${expiresAt}T23:59:59Z`) - days * DAY_MS;
}

describe("checkTokenExpiry", () => {
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

  it("ignoriert Provider ohne tokenExpiresAt", () => {
    const store = newStore();
    expect(checkTokenExpiry([provider()], store)).toEqual([]);
    store.close();
  });

  it("warnt nicht ausserhalb der Schwellwerte", () => {
    const store = newStore();
    const p = provider({ tokenExpiresAt: "2026-12-01" });
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 30))).toEqual([]);
    store.close();
  });

  it("warnt genau einmal pro Stufe und eskaliert", () => {
    const store = newStore();
    const p = provider({ tokenExpiresAt: "2026-12-01" });

    // T-10 → Stufe 14 feuert einmal
    const first = checkTokenExpiry([p], store, nowBefore("2026-12-01", 10));
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe("tokenExpiry");
    expect(first[0].daysLeft).toBe(10);
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 10))).toEqual([]);
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 9))).toEqual([]);

    // T-5 → Stufe 7 feuert einmal
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 5))).toHaveLength(1);
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 4))).toEqual([]);

    // T-1 → Stufe 1, danach Ablauf → Stufe 0
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 1))).toHaveLength(1);
    const expired = checkTokenExpiry([p], store, () => Date.parse("2026-12-02T12:00:00Z"));
    expect(expired).toHaveLength(1);
    expect(expired[0].daysLeft).toBe(0);
    expect(expired[0].message).toContain("abgelaufen");
    store.close();
  });

  it("überspringt beim späten Konfigurieren die verpassten Stufen", () => {
    const store = newStore();
    const p = provider({ tokenExpiresAt: "2026-12-01" });
    // Erst bei T-3 konfiguriert → genau EINE Warnung (nicht drei nachgeholte)
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 3))).toHaveLength(1);
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 2))).toEqual([]);
    // T-1 ist eine neue, dringendere Stufe → feuert
    expect(checkTokenExpiry([p], store, nowBefore("2026-12-01", 1))).toHaveLength(1);
    store.close();
  });

  it("setzt die Warnstufen zurück, wenn ein neues Ablaufdatum konfiguriert wird", () => {
    const store = newStore();
    const old = provider({ tokenExpiresAt: "2026-12-01" });
    expect(checkTokenExpiry([old], store, nowBefore("2026-12-01", 5))).toHaveLength(1);

    // Token erneuert, neues Datum — Watchdog beginnt von vorn.
    const renewed = provider({ tokenExpiresAt: "2027-02-01" });
    expect(checkTokenExpiry([renewed], store, nowBefore("2027-02-01", 60))).toEqual([]);
    expect(checkTokenExpiry([renewed], store, nowBefore("2027-02-01", 10))).toHaveLength(1);
    store.close();
  });
});
