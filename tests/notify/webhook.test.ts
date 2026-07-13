import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { WebhookNotifier } from "../../src/notify/webhook.js";
import { logger } from "../../src/lib/logger.js";
import type { OpsEvent, SocialEvent } from "../../src/platforms/types.js";

const WEBHOOK = "https://hook.example.com";

function postEvent(): SocialEvent {
  return {
    schemaVersion: 1,
    source: "social",
    platform: "linkedin",
    type: "post",
    externalId: "urn:li:share:1",
    author: "Raptus AG",
    text: "Hallo Welt",
    context: "",
    url: "https://linkedin.com/feed/1",
    timestamp: "2026-07-13T10:00:00Z",
  };
}

function opsEvent(): OpsEvent {
  return {
    schemaVersion: 1,
    source: "social",
    type: "ops",
    kind: "tokenExpiry",
    platform: "linkedin",
    provider: "raptus-linkedin",
    providerName: "Raptus AG (LinkedIn)",
    daysLeft: 7,
    message: "Token läuft in 7 Tagen ab.",
    timestamp: "2026-07-13T10:00:00Z",
  };
}

describe("WebhookNotifier", () => {
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  it("entfernt externalId aus dem Contract, sendet den Rest unverändert", async () => {
    let receivedBody = "";
    mockAgent
      .get(WEBHOOK)
      .intercept({
        path: "/",
        method: "POST",
        body: (body) => {
          receivedBody = body;
          return true;
        },
      })
      .reply(200, "ok");

    await new WebhookNotifier(WEBHOOK, logger).send(postEvent());
    const payload = JSON.parse(receivedBody) as Record<string, unknown>;
    expect(payload.externalId).toBeUndefined();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      source: "social",
      platform: "linkedin",
      type: "post",
      author: "Raptus AG",
    });
  });

  it("sendet Ops-Events unverändert (type ops, kind, message)", async () => {
    let receivedBody = "";
    mockAgent
      .get(WEBHOOK)
      .intercept({
        path: "/",
        method: "POST",
        body: (body) => {
          receivedBody = body;
          return true;
        },
      })
      .reply(200, "ok");

    await new WebhookNotifier(WEBHOOK, logger).sendOps(opsEvent());
    const payload = JSON.parse(receivedBody) as Record<string, unknown>;
    expect(payload.type).toBe("ops");
    expect(payload.kind).toBe("tokenExpiry");
    expect(payload.daysLeft).toBe(7);
  });

  it("wirft bei nicht-2xx-Antwort (Loop markiert dann nicht als gesehen)", async () => {
    mockAgent.get(WEBHOOK).intercept({ path: "/", method: "POST" }).reply(400, "bad contract");

    await expect(new WebhookNotifier(WEBHOOK, logger).send(postEvent())).rejects.toThrow(
      /HTTP 400/,
    );
  });
});
