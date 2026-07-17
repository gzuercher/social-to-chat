import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, readEnvFile, updateEnvFile } from "../../src/lib/envFile.js";

describe("envFile", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    Reflect.deleteProperty(process.env, "ENVFILE_TEST_A");
    Reflect.deleteProperty(process.env, "ENVFILE_TEST_B");
  });

  function tmpFile(content?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    dirs.push(dir);
    const path = join(dir, ".env");
    if (content !== undefined) writeFileSync(path, content);
    return path;
  }

  it("ersetzt bestehende Keys und erhält Kommentare/Reihenfolge", () => {
    const path = tmpFile("# Kommentar bleibt\nFOO=alt\n\nBAR=bleibt\n");
    updateEnvFile(path, { FOO: "neu" });
    expect(readFileSync(path, "utf8")).toBe("# Kommentar bleibt\nFOO=neu\n\nBAR=bleibt\n");
  });

  it("hängt unbekannte Keys ans Ende an und erstellt fehlende Dateien", () => {
    const path = tmpFile("FOO=1\n");
    updateEnvFile(path, { NEU: "x", FOO: "2" });
    expect(readEnvFile(path)).toEqual({ FOO: "2", NEU: "x" });

    const fresh = tmpFile();
    updateEnvFile(fresh, { A: "1" });
    expect(readEnvFile(fresh)).toEqual({ A: "1" });
  });

  it("loadEnvFile setzt nur ungesetzte Variablen (Container-ENV hat Vorrang)", () => {
    const path = tmpFile("ENVFILE_TEST_A=aus-datei\nENVFILE_TEST_B=aus-datei\n");
    process.env.ENVFILE_TEST_A = "aus-container";
    loadEnvFile(path);
    expect(process.env.ENVFILE_TEST_A).toBe("aus-container");
    expect(process.env.ENVFILE_TEST_B).toBe("aus-datei");
  });
});
