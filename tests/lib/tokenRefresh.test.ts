import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { Store } from "../../src/state/store.js";
import { ensureFreshTokens, hasRefreshConfig } from "../../src/lib/tokenRefresh.js";
import { logger } from "../../src/lib/logger.js";
import type { PlatformConfig } from "../../src/lib/config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const ENV_KEYS = ["T_LI_TOKEN", "T_LI_REFRESH", "T_LI_ID", "T_LI_SECRET"] as const;

function linkedinCfg(): PlatformConfig {
  return {
    key: "raptus-linkedin",
    platform: "linkedin",
    name: "Raptus AG (LinkedIn)",
    enabled: true,
    options: {
      organizationUrn: "urn:li:organization:123",
      tokenEnv: "T_LI_TOKEN",
      refresh: {
        refreshTokenEnv: "T_LI_REFRESH",
        clientIdEnv: "T_LI_ID",
        clientSecretEnv: "T_LI_SECRET",
      },
    },
  };
}

describe("ensureFreshTokens", () => {
  const dirs: string[] = [];
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    process.env.T_LI_TOKEN = "alter-access";
    process.env.T_LI_REFRESH = "refresh-1";
    process.env.T_LI_ID = "client-id";
    process.env.T_LI_SECRET = "client-secret";
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  function newStore(): Store {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    dirs.push(dir);
    return new Store(join(dir, "test.db"));
  }

  function mockLinkedInToken(body: Record<string, unknown>, status = 200): void {
    mockAgent
      .get("https://www.linkedin.com")
      .intercept({ path: "/oauth/v2/accessToken", method: "POST" })
      .reply(status, JSON.stringify(body));
  }

  it("hasRefreshConfig erkennt den refresh-Block", () => {
    expect(hasRefreshConfig(linkedinCfg())).toBe(true);
    expect(hasRefreshConfig({ ...linkedinCfg(), options: { tokenEnv: "T_LI_TOKEN" } })).toBe(false);
  });

  it("erneuert bei unbekanntem Ablauf, injiziert ENV und persistiert Rotation", async () => {
    const store = newStore();
    mockLinkedInToken({
      access_token: "neuer-access",
      expires_in: 60 * 24 * 60 * 60,
      refresh_token: "refresh-2",
      refresh_token_expires_in: 365 * 24 * 60 * 60,
    });

    const events = await ensureFreshTokens([linkedinCfg()], store, logger);
    expect(events).toEqual([]);
    expect(process.env.T_LI_TOKEN).toBe("neuer-access");

    // Zustand persistiert: zweiter Lauf ist NICHT fällig → kein Netz-Call
    // (MockAgent würde ohne Intercept werfen).
    await ensureFreshTokens([linkedinCfg()], store, logger);
    expect(process.env.T_LI_TOKEN).toBe("neuer-access");
    store.close();
  });

  it("erneuert erst, wenn die Margin unterschritten ist", async () => {
    const store = newStore();
    const t0 = Date.parse("2026-07-15T08:00:00Z");
    mockLinkedInToken({
      access_token: "access-a",
      expires_in: 60 * 24 * 60 * 60, // 60 Tage
      refresh_token_expires_in: 365 * 24 * 60 * 60,
    });
    await ensureFreshTokens([linkedinCfg()], store, logger, () => t0);

    // 40 Tage später: noch >7 Tage Rest → kein Refresh (kein Intercept nötig).
    await ensureFreshTokens([linkedinCfg()], store, logger, () => t0 + 40 * DAY_MS);

    // 55 Tage später: <7 Tage Rest → Refresh fällig.
    mockLinkedInToken({ access_token: "access-b", expires_in: 60 * 24 * 60 * 60 });
    await ensureFreshTokens([linkedinCfg()], store, logger, () => t0 + 55 * DAY_MS);
    expect(process.env.T_LI_TOKEN).toBe("access-b");
    store.close();
  });

  it("übernimmt eine neue manuelle Autorisierung (geänderter ENV-Refresh-Token)", async () => {
    const store = newStore();
    mockLinkedInToken({ access_token: "access-a", expires_in: 3600 });
    await ensureFreshTokens([linkedinCfg()], store, logger);

    // Mensch hat neu autorisiert: neuer Refresh-Token in der ENV.
    process.env.T_LI_REFRESH = "refresh-NEU";
    process.env.T_LI_TOKEN = "frischer-consent-access";
    let sentBody = "";
    mockAgent
      .get("https://www.linkedin.com")
      .intercept({
        path: "/oauth/v2/accessToken",
        method: "POST",
        body: (b) => {
          sentBody = b;
          return true;
        },
      })
      .reply(200, JSON.stringify({ access_token: "access-neu", expires_in: 3600 }));

    await ensureFreshTokens([linkedinCfg()], store, logger);
    expect(sentBody).toContain("refresh_token=refresh-NEU");
    expect(process.env.T_LI_TOKEN).toBe("access-neu");
    store.close();
  });

  it("meldet fehlgeschlagenen Refresh als Ops-Event, aber max. einmal pro 24 h", async () => {
    const store = newStore();
    const t0 = Date.parse("2026-07-15T08:00:00Z");
    mockLinkedInToken({ error: "invalid_grant", error_description: "revoked" }, 400);

    const first = await ensureFreshTokens([linkedinCfg()], store, logger, () => t0);
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe("tokenExpiry");
    expect(first[0].message).toContain("Auto-Refresh");

    // 1 h später: wieder fällig, wieder Fehler — aber KEIN zweites Ops-Event.
    mockLinkedInToken({ error: "invalid_grant" }, 400);
    const second = await ensureFreshTokens([linkedinCfg()], store, logger, () => t0 + 3600_000);
    expect(second).toEqual([]);

    // >24 h später: erneut warnen.
    mockLinkedInToken({ error: "invalid_grant" }, 400);
    const third = await ensureFreshTokens([linkedinCfg()], store, logger, () => t0 + 25 * 3600_000);
    expect(third).toHaveLength(1);
    store.close();
  });

  it("warnt vor Ablauf des Refresh-Tokens (Re-Autorisierung durch Mensch)", async () => {
    const store = newStore();
    const t0 = Date.parse("2026-07-15T08:00:00Z");
    mockLinkedInToken({
      access_token: "access-a",
      expires_in: 60 * 24 * 60 * 60,
      refresh_token_expires_in: 10 * 24 * 60 * 60, // Refresh-Token nur noch 10 Tage!
    });

    const events = await ensureFreshTokens([linkedinCfg()], store, logger, () => t0);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tokenExpiry");
    expect(events[0].daysLeft).toBeLessThanOrEqual(14);
    expect(events[0].message).toContain("autorisieren");

    // Gleiche Stufe feuert nicht doppelt.
    const again = await ensureFreshTokens([linkedinCfg()], store, logger, () => t0 + 3600_000);
    expect(again).toEqual([]);
    store.close();
  });

  it("ignoriert Provider ohne refresh-Block und Plattformen ohne Refresh-Flow", async () => {
    const store = newStore();
    const facebook: PlatformConfig = {
      key: "raptus-facebook",
      platform: "facebook",
      name: "Raptus AG",
      enabled: true,
      options: {
        pageId: "111",
        tokenEnv: "T_LI_TOKEN",
        refresh: {
          refreshTokenEnv: "T_LI_REFRESH",
          clientIdEnv: "T_LI_ID",
          clientSecretEnv: "T_LI_SECRET",
        },
      },
    };
    const plain: PlatformConfig = {
      key: "raptus-plain",
      platform: "linkedin",
      name: "",
      enabled: true,
      options: { tokenEnv: "T_LI_TOKEN" },
    };
    // Kein Intercept registriert: jeder Netz-Call würde den Test brechen.
    const events = await ensureFreshTokens([facebook, plain], store, logger);
    expect(events).toEqual([]);
    store.close();
  });
});
