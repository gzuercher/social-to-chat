import { describe, expect, it } from "vitest";
import { defaultApiVersion } from "../../src/platforms/linkedin.js";

describe("defaultApiVersion", () => {
  it("liefert den Vormonat als YYYYMM", () => {
    expect(defaultApiVersion(new Date("2026-07-19T10:00:00Z"))).toBe("202606");
    expect(defaultApiVersion(new Date("2026-12-01T00:00:00Z"))).toBe("202611");
  });

  it("rollt über den Jahreswechsel korrekt zurück", () => {
    expect(defaultApiVersion(new Date("2027-01-15T00:00:00Z"))).toBe("202612");
  });

  it("wächst automatisch mit — nie wieder eine abgelaufene Version im Code", () => {
    // Regression: eine fest gepinnte Version lief nach ~12 Monaten mit
    // HTTP 426 NONEXISTENT_VERSION auf (beim ersten Live-Lauf passiert).
    const inTwoYears = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
    expect(Number(defaultApiVersion(inTwoYears))).toBeGreaterThan(
      Number(defaultApiVersion(new Date())),
    );
  });
});
