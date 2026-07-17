import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Minimaler .env-Editor für den Setup-Wizard.
 *
 * Erhält Kommentare und Zeilen-Reihenfolge: bestehende `KEY=VALUE`-Zeilen
 * werden ersetzt, unbekannte Keys ans Ende angehängt. Kein Quoting — die
 * Werte werden von docker compose / dem dotenv-Loader wörtlich gelesen.
 */
export function updateEnvFile(path: string, updates: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const remaining = new Map(Object.entries(updates));

  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m && remaining.has(m[1])) {
      const value = remaining.get(m[1]) as string;
      remaining.delete(m[1]);
      return `${m[1]}=${value}`;
    }
    return line;
  });

  if (remaining.size > 0) {
    while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
    out.push("");
    for (const [key, value] of remaining) out.push(`${key}=${value}`);
  }

  writeFileSync(path, `${out.join("\n").replace(/\n+$/, "")}\n`);
}

/** Liest eine .env-Datei als Key/Value-Map (Kommentare/Leerzeilen ignoriert). */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

/**
 * Lädt .env-Werte in process.env, ohne bereits gesetzte Variablen zu
 * überschreiben (Container-ENV hat Vorrang vor der Datei).
 */
export function loadEnvFile(path: string): void {
  for (const [key, value] of Object.entries(readEnvFile(path))) {
    if (process.env[key] === undefined && value !== "") process.env[key] = value;
  }
}
