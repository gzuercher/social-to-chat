import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { LinkedInProvider } from "../../src/platforms/linkedin.js";
import { logger } from "../../src/lib/logger.js";
import type { PlatformConfig } from "../../src/lib/config.js";
import type { PostRef } from "../../src/platforms/types.js";

const ORIGIN = "https://api.linkedin.com";
const TOKEN_ENV = "TEST_LINKEDIN_TOKEN";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

function cfg(): PlatformConfig {
  return {
    key: "raptus-linkedin",
    platform: "linkedin",
    name: "Raptus AG (LinkedIn)",
    enabled: true,
    options: { organizationUrn: "urn:li:organization:123", tokenEnv: TOKEN_ENV },
  };
}

function postRef(externalId: string): PostRef {
  return {
    externalId,
    url: `https://www.linkedin.com/feed/update/${externalId}/`,
    text: "Wir stellen ein! Werde Teil des Raptus-Teams.",
    publishedAt: "2026-07-12T08:00:00.000Z",
  };
}

describe("LinkedInProvider", () => {
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

  it("wirft bei ungültigen options und fehlendem Token", async () => {
    expect(() => new LinkedInProvider({ ...cfg(), options: {} }, logger)).toThrow(/options/);
    expect(
      () =>
        new LinkedInProvider(
          { ...cfg(), options: { ...cfg().options, organizationUrn: "123" } },
          logger,
        ),
    ).toThrow(/options/);

    Reflect.deleteProperty(process.env, TOKEN_ENV);
    const provider = new LinkedInProvider(cfg(), logger);
    await expect(provider.fetchPosts()).rejects.toThrow(new RegExp(TOKEN_ENV));
  });

  it("mappt Posts auf SocialEvents (URN, Autor, URL, ISO-Zeit)", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith("/rest/posts"), method: "GET" })
      .reply(200, fixture("linkedin-posts.json"));

    const events = await new LinkedInProvider(cfg(), logger).fetchPosts();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      source: "social",
      platform: "linkedin",
      type: "post",
      externalId: "urn:li:share:7001",
      author: "Raptus AG (LinkedIn)",
      url: "https://www.linkedin.com/feed/update/urn:li:share:7001/",
    });
    expect(events[0].timestamp).toBe(new Date(1783900800000).toISOString());
    // Fallback createdAt, wenn publishedAt fehlt:
    expect(events[1].timestamp).toBe(new Date(1783814400000).toISOString());
  });

  it("mappt Kommentare defensiv (commentUrn ODER id, createdAt ODER created.time)", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith("/rest/socialActions/"), method: "GET" })
      .reply(200, fixture("linkedin-comments.json"));

    const events = await new LinkedInProvider(cfg(), logger).fetchComments([
      postRef("urn:li:share:7001"),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "comment",
      externalId: "urn:li:comment:(urn:li:activity:7001,111)",
      author: "urn:li:person:abc123",
      text: "Spannend! Gilt das auch für Teilzeit?",
      url: "https://www.linkedin.com/feed/update/urn:li:share:7001/",
    });
    expect(events[0].context).toContain("Wir stellen ein");
    expect(events[1].externalId).toBe("222");
    expect(events[1].timestamp).toBe(new Date(1783906000000).toISOString());
  });

  it("wirft bei HTTP 401 (Token tot → HealthTracker)", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith("/rest/posts"), method: "GET" })
      .reply(401, '{"message":"expired"}');

    await expect(new LinkedInProvider(cfg(), logger).fetchPosts()).rejects.toThrow(/HTTP 401/);
  });

  it("Kommentare: einzelner kaputter Post kippt den Lauf nicht, alle kaputt schon", async () => {
    const pool = mockAgent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.includes("7001"), method: "GET" })
      .reply(404, "gone")
      .times(1); // 404 ist nicht retrybar → genau ein Request
    pool
      .intercept({ path: (p) => p.includes("7002"), method: "GET" })
      .reply(200, fixture("linkedin-comments.json"));

    const provider = new LinkedInProvider(cfg(), logger);
    const events = await provider.fetchComments([
      postRef("urn:li:share:7001"),
      postRef("urn:li:ugcPost:7002"),
    ]);
    expect(events).toHaveLength(2); // nur vom intakten Post

    // Alle Posts scheitern → Fehler muss hochkommen (frischer Post 7003,
    // damit keine der obigen Intercepts greift).
    pool
      .intercept({ path: (p) => p.includes("7003"), method: "GET" })
      .reply(401, "expired")
      .times(1);
    await expect(provider.fetchComments([postRef("urn:li:share:7003")])).rejects.toThrow(
      /HTTP 401/,
    );
  });
});
