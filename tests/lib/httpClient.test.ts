import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { httpGet, httpPost } from "../../src/lib/httpClient.js";

describe("httpClient", () => {
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

  it("liefert Status, Content-Type und Body", async () => {
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/ok", method: "GET" })
      .reply(200, '{"a":1}', { headers: { "content-type": "application/json" } });

    const res = await httpGet("https://api.example.com/ok");
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/json");
    expect(res.body).toBe('{"a":1}');
  });

  it("wiederholt bei 429 und respektiert Retry-After", async () => {
    const pool = mockAgent.get("https://api.example.com");
    pool
      .intercept({ path: "/flaky", method: "GET" })
      .reply(429, "slow down", { headers: { "retry-after": "0" } })
      .times(1);
    pool.intercept({ path: "/flaky", method: "GET" }).reply(200, "ok").times(1);

    const res = await httpGet("https://api.example.com/flaky");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("gibt nach erschöpften Retries die letzte Antwort zurück", async () => {
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/broken", method: "GET" })
      .reply(429, "nope", { headers: { "retry-after": "0" } })
      .times(3); // Erstversuch + 2 Retries

    const res = await httpGet("https://api.example.com/broken");
    expect(res.status).toBe(429);
  });

  it("retries: 0 schaltet Wiederholungen ab", async () => {
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/once", method: "GET" })
      .reply(500, "boom")
      .times(1);

    const res = await httpGet("https://api.example.com/once", { retries: 0 });
    expect(res.status).toBe(500);
  });

  it("wiederholt 4xx (ausser 429) nicht", async () => {
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/notfound", method: "GET" })
      .reply(404, "missing")
      .times(1);

    const res = await httpGet("https://api.example.com/notfound");
    expect(res.status).toBe(404);
  });

  it("httpPost serialisiert den Payload als JSON", async () => {
    let receivedBody = "";
    mockAgent
      .get("https://hook.example.com")
      .intercept({
        path: "/webhook",
        method: "POST",
        body: (body) => {
          receivedBody = body;
          return true;
        },
      })
      .reply(202, "accepted");

    const res = await httpPost("https://hook.example.com/webhook", { hello: "welt" });
    expect(res.status).toBe(202);
    expect(JSON.parse(receivedBody)).toEqual({ hello: "welt" });
  });
});
