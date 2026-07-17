import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument, YAMLMap, YAMLSeq } from "yaml";

/**
 * Kommentar-erhaltender Editor für config/platforms.yaml (Setup-Wizard).
 *
 * Nutzt die Document-API des yaml-Pakets: Kommentare, Reihenfolge und
 * Formatierung der Datei bleiben stehen, nur die gepatchten Werte ändern
 * sich. Existiert die Datei noch nicht, dient die .example als Vorlage.
 */
export type PlatformPatch = {
  enabled?: boolean;
  /** tokenExpiresAt entfernen (bei aktivem Auto-Refresh obsolet). */
  removeTokenExpiresAt?: boolean;
  /** Zu setzende options-Felder (z. B. organizationUrn, refresh-Block). */
  options?: Record<string, unknown>;
};

export function updatePlatformsYaml(
  path: string,
  examplePath: string,
  platform: string,
  patch: PlatformPatch,
): void {
  const source = existsSync(path) ? path : examplePath;
  const doc = parseDocument(readFileSync(source, "utf8"));

  const platforms = doc.get("platforms");
  if (!(platforms instanceof YAMLSeq)) {
    throw new Error(`platforms-Liste fehlt in ${source}`);
  }
  const idx = platforms.items.findIndex(
    (item) => item instanceof YAMLMap && item.get("platform") === platform,
  );
  if (idx < 0) {
    throw new Error(`Kein Eintrag für Plattform "${platform}" in ${source}`);
  }

  if (patch.enabled !== undefined) doc.setIn(["platforms", idx, "enabled"], patch.enabled);
  if (patch.removeTokenExpiresAt) doc.deleteIn(["platforms", idx, "tokenExpiresAt"]);
  for (const [key, value] of Object.entries(patch.options ?? {})) {
    doc.setIn(["platforms", idx, "options", key], value);
  }

  writeFileSync(path, doc.toString());
}
