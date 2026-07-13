import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { FacebookProvider } from "../../src/platforms/facebook.js";
import { logger } from "../../src/lib/logger.js";
import type { PlatformConfig } from "../../src/lib/config.js";
import type { PostRef } from "../../src/platforms/types.js";

const ORIGIN = "https://graph.facebook.com";
const TOKEN_ENV = "TEST_FACEBOOK_TOKEN";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

function cfg(): PlatformConfig {
  return {
    key: "raptus-facebook",
    platform: "facebook",
    name: "Raptus AG",
    enabled: true,
    options: { pageId: "111", tokenEnv: TOKEN_ENV },
  };
}

describe("FacebookProvider", () => {
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
    expect(() => new FacebookProvider({ ...cfg(), options: {} }, logger)).toThrow(/options/);
  });

  it("mappt published_posts auf SocialEvents", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.includes("/111/published_posts"), method: "GET" })
      .reply(200, fixture("facebook-posts.json"));

    const events = await new FacebookProvider(cfg(), logger).fetchPosts();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      platform: "facebook",
      type: "post",
      externalId: "111_222",
      author: "Raptus AG",
      text: "Sommerfest bei Raptus — danke an alle!",
      url: "https://www.facebook.com/111/posts/222",
    });
    expect(events[0].timestamp).toBe(new Date("2026-07-10T09:30:00+0000").toISOString());
    // Post ohne message → leerer Text, kein Absturz.
    expect(events[1].text).toBe("");
  });

  it("mappt Kommentare inkl. fehlendem from (Privatsphäre)", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.includes("/111_222/comments"), method: "GET" })
      .reply(200, fixture("facebook-comments.json"));

    const post: PostRef = {
      externalId: "111_222",
      url: "https://www.facebook.com/111/posts/222",
      text: "Sommerfest bei Raptus — danke an alle!",
      publishedAt: "2026-07-10T09:30:00.000Z",
    };
    const events = await new FacebookProvider(cfg(), logger).fetchComments([post]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "comment",
      externalId: "222_333",
      author: "Max Muster",
      url: "https://www.facebook.com/222?comment_id=333",
    });
    expect(events[1].author).toBe("Facebook-Nutzer");
    expect(events[1].url).toBe(post.url); // Fallback auf Post-URL
  });

  it("wirft bei HTTP 401", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.includes("/published_posts"), method: "GET" })
      .reply(401, '{"error":{"message":"expired"}}');

    await expect(new FacebookProvider(cfg(), logger).fetchPosts()).rejects.toThrow(/HTTP 401/);
  });
});
