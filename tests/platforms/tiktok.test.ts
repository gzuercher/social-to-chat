import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { TikTokProvider } from "../../src/platforms/tiktok.js";
import { logger } from "../../src/lib/logger.js";
import type { PlatformConfig } from "../../src/lib/config.js";

const ORIGIN = "https://open.tiktokapis.com";
const TOKEN_ENV = "TEST_TIKTOK_TOKEN";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

function cfg(): PlatformConfig {
  return {
    key: "raptus-tiktok",
    platform: "tiktok",
    name: "Raptus AG (TikTok)",
    enabled: true,
    options: { tokenEnv: TOKEN_ENV },
  };
}

describe("TikTokProvider", () => {
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    process.env[TOKEN_ENV] = "test-token";
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    Reflect.deleteProperty(process.env, TOKEN_ENV);
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  it("mappt video/list auf SocialEvents (Unix-Sekunden → ISO)", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith("/v2/video/list/"), method: "POST" })
      .reply(200, fixture("tiktok-videos.json"));

    const events = await new TikTokProvider(cfg(), logger).fetchPosts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: "tiktok",
      type: "post",
      externalId: "v7345001",
      author: "Raptus AG (TikTok)",
      text: "Ein Tag im Rechenzentrum #raptus #datacenter",
      url: "https://www.tiktok.com/@raptus/video/7345001",
    });
    expect(events[0].timestamp).toBe(new Date(1783800000 * 1000).toISOString());
  });

  it("wirft bei TikTok-Fehlercode im Body (HTTP 200, error.code != ok)", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith("/v2/video/list/"), method: "POST" })
      .reply(
        200,
        JSON.stringify({ data: {}, error: { code: "access_token_invalid", message: "bad token" } }),
      );

    await expect(new TikTokProvider(cfg(), logger).fetchPosts()).rejects.toThrow(
      /access_token_invalid/,
    );
  });

  it("fetchComments liefert dauerhaft [] (keine Kommentar-Lese-API)", async () => {
    const events = await new TikTokProvider(cfg(), logger).fetchComments([
      {
        externalId: "v7345001",
        url: "https://www.tiktok.com/@raptus/video/7345001",
        text: "x",
        publishedAt: "2026-07-11T00:00:00.000Z",
      },
    ]);
    expect(events).toEqual([]);
  });
});
