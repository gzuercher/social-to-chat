/**
 * JSON-Parsing für Adapter-Antworten. Wirft mit „JSON parsing failed" im
 * Fehlertext — genau die Formulierung, die errorCategory als
 * "Invalid response format" kategorisiert.
 */
export function parseJson<T>(body: string, context: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${context}: JSON parsing failed: ${body.slice(0, 120)}`);
  }
}
