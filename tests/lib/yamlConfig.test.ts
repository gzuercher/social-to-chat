import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { updatePlatformsYaml } from "../../src/lib/yamlConfig.js";

const EXAMPLE = `# Kopf-Kommentar bleibt stehen
schedule: "*/5 * * * *"
platforms:
  - key: raptus-linkedin
    platform: linkedin
    name: "Raptus AG (LinkedIn)"
    enabled: false
    tokenExpiresAt: "2026-09-01"
    options:
      organizationUrn: "urn:li:organization:XXXXXXXX"
      tokenEnv: "LINKEDIN_ACCESS_TOKEN"
  - key: raptus-facebook
    platform: facebook
    enabled: false
    options:
      pageId: "XXXX"
      tokenEnv: "FACEBOOK_PAGE_TOKEN"
`;

describe("updatePlatformsYaml", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function setup(): { path: string; examplePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    dirs.push(dir);
    const examplePath = join(dir, "platforms.yaml.example");
    writeFileSync(examplePath, EXAMPLE);
    return { path: join(dir, "platforms.yaml"), examplePath };
  }

  it("erstellt die Datei aus dem Example und patcht nur die Ziel-Plattform", () => {
    const { path, examplePath } = setup();
    updatePlatformsYaml(path, examplePath, "linkedin", {
      enabled: true,
      removeTokenExpiresAt: true,
      options: {
        organizationUrn: "urn:li:organization:123",
        refresh: {
          refreshTokenEnv: "LINKEDIN_REFRESH_TOKEN",
          clientIdEnv: "LINKEDIN_CLIENT_ID",
          clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
        },
      },
    });

    const text = readFileSync(path, "utf8");
    expect(text).toContain("# Kopf-Kommentar bleibt stehen");

    const parsed = parse(text) as {
      platforms: {
        key: string;
        enabled: boolean;
        tokenExpiresAt?: string;
        options: Record<string, unknown>;
      }[];
    };
    const li = parsed.platforms.find((p) => p.key === "raptus-linkedin");
    expect(li?.enabled).toBe(true);
    expect(li?.tokenExpiresAt).toBeUndefined();
    expect(li?.options.organizationUrn).toBe("urn:li:organization:123");
    expect(li?.options.refresh).toMatchObject({ refreshTokenEnv: "LINKEDIN_REFRESH_TOKEN" });
    // Facebook unangetastet:
    const fb = parsed.platforms.find((p) => p.key === "raptus-facebook");
    expect(fb?.enabled).toBe(false);
    expect(fb?.options.pageId).toBe("XXXX");
  });

  it("patcht eine bestehende Datei weiter (zweiter Aufruf)", () => {
    const { path, examplePath } = setup();
    updatePlatformsYaml(path, examplePath, "linkedin", { enabled: true });
    updatePlatformsYaml(path, examplePath, "facebook", {
      enabled: true,
      options: { pageId: "111" },
    });

    const parsed = parse(readFileSync(path, "utf8")) as {
      platforms: { key: string; enabled: boolean; options: Record<string, unknown> }[];
    };
    expect(parsed.platforms.find((p) => p.key === "raptus-linkedin")?.enabled).toBe(true);
    expect(parsed.platforms.find((p) => p.key === "raptus-facebook")?.options.pageId).toBe("111");
  });

  it("wirft bei unbekannter Plattform", () => {
    const { path, examplePath } = setup();
    expect(() => updatePlatformsYaml(path, examplePath, "tiktok", { enabled: true })).toThrow(
      /tiktok/,
    );
  });
});
