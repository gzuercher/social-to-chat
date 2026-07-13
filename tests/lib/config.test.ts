import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/lib/config.js";

const MINIMAL_YAML = `
webhookUrl: "\${TEST_WEBHOOK_URL}"
platforms:
  - key: raptus-linkedin
    platform: linkedin
    options:
      tokenEnv: "LINKEDIN_ACCESS_TOKEN"
`;

describe("loadConfig", () => {
  const dirs: string[] = [];
  const envKeys = ["TEST_WEBHOOK_URL", "WEBHOOK_URL", "STATE_DB_PATH"];
  const savedEnv = new Map<string, string | undefined>();

  for (const key of envKeys) savedEnv.set(key, process.env[key]);

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    for (const key of envKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  function writeYaml(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    dirs.push(dir);
    const path = join(dir, "platforms.yaml");
    writeFileSync(path, content);
    return path;
  }

  it("löst ${ENV}-Platzhalter auf und setzt Defaults", () => {
    process.env.TEST_WEBHOOK_URL = "https://hook.example.com/x";
    delete process.env.WEBHOOK_URL;
    delete process.env.STATE_DB_PATH;

    const config = loadConfig(writeYaml(MINIMAL_YAML));
    expect(config.webhookUrl).toBe("https://hook.example.com/x");
    expect(config.schedule).toBe("*/5 * * * *");
    expect(config.dbPath).toBe("./data/social-to-chat.db");
    expect(config.platforms[0].enabled).toBe(true);
  });

  it("wirft bei unbekannter ENV-Variable im Platzhalter", () => {
    delete process.env.TEST_WEBHOOK_URL;
    delete process.env.WEBHOOK_URL;
    expect(() => loadConfig(writeYaml(MINIMAL_YAML))).toThrow(/TEST_WEBHOOK_URL/);
  });

  it("ENV WEBHOOK_URL und STATE_DB_PATH haben Vorrang vor der YAML", () => {
    process.env.TEST_WEBHOOK_URL = "https://yaml.example.com";
    process.env.WEBHOOK_URL = "https://env.example.com";
    process.env.STATE_DB_PATH = "/data/override.db";

    const config = loadConfig(writeYaml(MINIMAL_YAML + 'dbPath: "./yaml.db"\n'));
    expect(config.webhookUrl).toBe("https://env.example.com");
    expect(config.dbPath).toBe("/data/override.db");
  });

  it("lehnt eine ungültige Webhook-URL ab", () => {
    process.env.TEST_WEBHOOK_URL = "keine-url";
    delete process.env.WEBHOOK_URL;
    expect(() => loadConfig(writeYaml(MINIMAL_YAML))).toThrow();
  });

  it("lehnt ein ungültiges tokenExpiresAt ab, akzeptiert ISO-Datum", () => {
    process.env.TEST_WEBHOOK_URL = "https://hook.example.com/x";
    delete process.env.WEBHOOK_URL;

    const valid = MINIMAL_YAML.replace(
      "    options:",
      '    tokenExpiresAt: "2026-09-01"\n    options:',
    );
    expect(loadConfig(writeYaml(valid)).platforms[0].tokenExpiresAt).toBe("2026-09-01");

    const invalid = MINIMAL_YAML.replace(
      "    options:",
      '    tokenExpiresAt: "bald"\n    options:',
    );
    expect(() => loadConfig(writeYaml(invalid))).toThrow();
  });
});
