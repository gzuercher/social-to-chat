import { describe, expect, it } from "vitest";
import { categorizeError } from "../../src/lib/errorCategory.js";

describe("categorizeError", () => {
  it("maps 401/403 to Authentication failed (Token-Signal)", () => {
    expect(categorizeError(new Error("Webhook antwortete HTTP 401: unauthorized"))).toBe(
      "Authentication failed",
    );
    expect(categorizeError(new Error("HTTP 403"))).toBe("Authentication failed");
  });

  it("maps other HTTP status codes verbatim", () => {
    expect(categorizeError(new Error("HTTP 404"))).toBe("HTTP 404");
    expect(categorizeError(new Error("request failed with HTTP 503 from upstream"))).toBe(
      "HTTP 503",
    );
  });

  it("recognises timeouts and network errors", () => {
    expect(categorizeError(new Error("This operation was aborted"))).toBe("Timeout");
    expect(categorizeError(new Error("getaddrinfo ENOTFOUND api.linkedin.com"))).toBe(
      "DNS lookup failed",
    );
    expect(categorizeError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(
      "Connection refused",
    );
    expect(categorizeError(new Error("self signed certificate in chain"))).toBe(
      "TLS certificate error",
    );
  });

  it("recognises parse errors", () => {
    expect(categorizeError(new Error("Unexpected token < in JSON at position 0"))).toBe(
      "Invalid response format",
    );
  });

  it("falls back to Unknown error for anything else", () => {
    expect(categorizeError(new Error("boom"))).toBe("Unknown error");
    expect(categorizeError(42)).toBe("Unknown error");
    expect(categorizeError({ message: "something odd" })).toBe("Unknown error");
  });
});
