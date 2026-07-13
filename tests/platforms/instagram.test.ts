import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { InstagramProvider } from "../../src/platforms/instagram.js";
import { logger } from "../../src/lib/logger.js";
import type { PlatformConfig } from "../../src/lib/config.js";
import type { PostRef } from "../../src/platforms/types.js";

const ORIGIN = "https://graph.facebook.com";
const TOKEN_ENV = "TEST_INSTAGRAM_TOKEN";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

function cfg(): PlatformConfig {
  return {
    key: "raptus-instagram",
    platform: "instagram",
    name: "raptus.ag",
    enabled: true,
    options: { igUserId: "9000", tokenEnv: TOKEN_ENV },
  };
}

describe("InstagramProvider", () => {
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

  it("wirft bei ungültigen options", () => {
    expect(() => new InstagramProvider({ ...cfg(), options: {} }, logger)).toThrow(/options/);
  });

  it("mappt media auf SocialEvents", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.includes("/9000/media"), method: "GET" })
      .reply(200, fixture("instagram-media.json"));

    const events = await new InstagramProvider(cfg(), logger).fetchPosts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: "instagram",
      type: "post",
      externalId: "9001",
      author: "raptus.ag",
      text: "Neues Büro in Biel 🎉 #raptus",
      url: "https://www.instagram.com/p/abc123/",
    });
  });

  it("mappt Kommentare (username als Autor, Post-URL als Link)", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.includes("/9001/comments"), method: "GET" })
      .reply(200, fixture("instagram-comments.json"));

    const post: PostRef = {
      externalId: "9001",
      url: "https://www.instagram.com/p/abc123/",
      text: "Neues Büro in Biel 🎉 #raptus",
      publishedAt: "2026-07-09T12:00:00.000Z",
    };
    const events = await new InstagramProvider(cfg(), logger).fetchComments([post]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "comment",
      externalId: "9002",
      author: "maxmuster",
      text: "Gratuliere! Sieht super aus.",
      url: post.url,
    });
    expect(events[0].context).toContain("Neues Büro");
  });

  it("wirft bei HTTP 401", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.includes("/media"), method: "GET" })
      .reply(401, '{"error":{"message":"expired"}}');

    await expect(new InstagramProvider(cfg(), logger).fetchPosts()).rejects.toThrow(/HTTP 401/);
  });
});
