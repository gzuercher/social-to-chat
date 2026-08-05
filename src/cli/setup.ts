import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { httpGet, httpPost } from "../lib/httpClient.js";
import { parseJson } from "../lib/json.js";
import { loadEnvFile, readEnvFile, updateEnvFile } from "../lib/envFile.js";
import { updatePlatformsYaml } from "../lib/yamlConfig.js";
import { loadConfig } from "../lib/config.js";

/**
 * Setup-Wizard: `node dist/src/main.js setup`
 *
 * Kleines Web-Interface (NUR auf localhost gebunden), das durch die
 * Token-Einrichtung führt — gedacht für die Erst-Einrichtung und für den
 * jährlichen LinkedIn-Re-Consent, ohne dass man sich die curl-Befehle
 * merken muss. Auf einem Server per SSH-Port-Forward erreichbar:
 *
 *     ssh -L 8911:localhost:8911 <server>   →   http://localhost:8911
 *
 * Was der Wizard automatisiert:
 *   • LinkedIn: kompletter OAuth-Authorization-Code-Flow. Der Wizard IST die
 *     Redirect-URI (http://localhost:8911/callback/linkedin — einmalig in der
 *     LinkedIn-App registrieren), tauscht den Code selbst, entdeckt die
 *     Organisation-URN per API und schreibt .env + platforms.yaml.
 *   • Meta: validiert den System-User-Token, findet Pages + verknüpfte
 *     IG-Business-Konten automatisch (me/accounts) und übernimmt den
 *     nie ablaufenden Page-Token.
 *   • TikTok: Paste-Modus (TikTok erlaubt keine localhost-Redirects) —
 *     validiert den Refresh-Token sofort per echtem Refresh und übernimmt
 *     den dabei ROTIERTEN Token korrekt in die .env.
 *
 * Secrets landen ausschließlich in der (gitignorierten) .env; die YAML
 * bekommt nur Struktur (IDs, ENV-Namen). Der Wizard läuft einmalig als
 * Subcommand, nicht im Poller-Container.
 */

const PORT = Number(process.env.SETUP_PORT ?? 8911);
/**
 * Bind-Adresse. Default localhost (SSH-Tunnel-Betrieb). Im Container hinter
 * einem authentifizierenden Reverse-Proxy (Caddy mit basic_auth):
 * SETUP_BIND=0.0.0.0 — NIE ohne vorgeschaltete Auth nach außen öffnen.
 */
const BIND = process.env.SETUP_BIND ?? "127.0.0.1";
/**
 * Öffentliche Basis-URL des Wizards, bestimmt die OAuth-Redirect-URI.
 * Hinter Caddy z. B. https://social-notifs-setup.example.com — diese
 * Redirect-URI einmalig in der LinkedIn-App registrieren.
 */
const PUBLIC_URL = (process.env.SETUP_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const ENV_PATH = process.env.ENV_PATH ?? "./.env";
const CONFIG_PATH = process.env.CONFIG_PATH ?? "./config/platforms.yaml";
const EXAMPLE_PATH = "./config/platforms.yaml.example";
const LINKEDIN_VERSION = "202506";
const GRAPH_BASE = "https://graph.facebook.com/v23.0";

const REDIRECT_URI = `${PUBLIC_URL}/callback/linkedin`;

/** Kurzlebiger In-Memory-Zustand zwischen zwei Wizard-Schritten. */
type PendingLinkedIn = {
  tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    refreshExpiresIn?: number;
  };
  orgs: string[];
};
type PendingMeta = {
  token: string;
  pages: { id: string; name: string; accessToken?: string; igId?: string; igName?: string }[];
};
const pending = new Map<string, PendingLinkedIn | PendingMeta>();
let oauthState = "";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — social-to-chat Setup</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#222}
  h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:2rem}
  a{color:#0a66c2} .card{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
  .ok{color:#1a7f37}.warn{color:#b35900}.err{color:#b00020}
  label{display:block;margin:.7rem 0 .2rem;font-weight:600}
  input[type=text],input[type=password]{width:100%;padding:.45rem;border:1px solid #bbb;border-radius:6px;font-family:monospace}
  button{margin-top:1rem;padding:.5rem 1.2rem;border:0;border-radius:6px;background:#0a66c2;color:#fff;font-size:1rem;cursor:pointer}
  code{background:#f4f4f4;padding:.1rem .3rem;border-radius:4px}
  .muted{color:#666;font-size:.9rem}
  nav a{margin-right:1rem}
</style></head><body>
<nav><a href="/">Übersicht</a><a href="/linkedin">LinkedIn</a><a href="/meta">Facebook/Instagram</a><a href="/tiktok">TikTok</a></nav>
<h1>${esc(title)}</h1>
${body}
<p class="muted" style="margin-top:3rem">social-to-chat Setup-Wizard · läuft nur auf localhost · Secrets gehen ausschließlich in die .env</p>
</body></html>`;
}

function send(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function envStatus(): Record<string, boolean> {
  const env = readEnvFile(ENV_PATH);
  const has = (k: string): boolean => (env[k] ?? "") !== "";
  return {
    webhook: has("WEBHOOK_URL"),
    linkedin: has("LINKEDIN_REFRESH_TOKEN") && has("LINKEDIN_CLIENT_ID"),
    facebook: has("FACEBOOK_PAGE_TOKEN"),
    instagram: has("INSTAGRAM_ACCESS_TOKEN"),
    tiktok: has("TIKTOK_REFRESH_TOKEN") && has("TIKTOK_CLIENT_KEY"),
  };
}

function validateSummary(): string {
  // .env in den Prozess laden, damit loadConfig() die ${ENV}-Platzhalter findet.
  loadEnvFile(ENV_PATH);
  try {
    const config = loadConfig();
    const active = config.platforms.filter((p) => p.enabled).map((p) => p.key);
    return `<p class="ok">✅ Konfiguration gültig — aktiv: ${esc(active.join(", ") || "keine Plattform")}</p>`;
  } catch (err) {
    return `<p class="warn">⚠️ Konfiguration (noch) nicht gültig: <code>${esc((err as Error).message.slice(0, 300))}</code></p>`;
  }
}

// ---------------------------------------------------------------- Übersicht

function overviewPage(): string {
  const s = envStatus();
  const badge = (ok: boolean): string => (ok ? '<span class="ok">✅</span>' : "⬜");
  return page(
    "Einrichtung",
    `
<p>Dieser Wizard richtet die Plattform-Tokens ein und schreibt <code>.env</code>
und <code>config/platforms.yaml</code>. Ein Schritt pro Plattform — in einem
Jahr beim LinkedIn-Re-Consent einfach wieder <code>setup</code> starten.</p>
<div class="card">${badge(s.webhook)} <b>Webhook</b> — Trigger-URL der social-feed Logic App (raptus-integration-router)</div>
<div class="card">${badge(s.linkedin)} <b>LinkedIn</b> — OAuth mit Auto-Refresh → <a href="/linkedin">einrichten / erneuern</a></div>
<div class="card">${badge(s.facebook && s.instagram)} <b>Facebook &amp; Instagram</b> — System-User-Token → <a href="/meta">einrichten</a></div>
<div class="card">${badge(s.tiktok)} <b>TikTok</b> — Refresh-Token (Paste-Modus) → <a href="/tiktok">einrichten</a></div>
<h2>Konfigurations-Check</h2>
${validateSummary()}
<p class="muted">Danach: <code>docker compose up -d --build</code> — der Erstlauf liest den Bestand still ein (kein Flood im Teams-Kanal).</p>`,
  );
}

// ---------------------------------------------------------------- LinkedIn

function linkedinFormPage(msg?: string): string {
  const env = readEnvFile(ENV_PATH);
  return page(
    "LinkedIn einrichten",
    `
${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<p><b>Einmalige Voraussetzung:</b> In der LinkedIn-App (Developer-Portal →
Auth) muss diese Redirect-URL eingetragen sein:</p>
<p><code>${esc(REDIRECT_URI)}</code></p>
<p>Danach führt dich der Wizard durch den Consent; Code-Tausch, Token-Ablage
und Organisations-Erkennung passieren automatisch. Der Poller erneuert den
Access-Token anschließend selbst (Re-Consent erst in ~12 Monaten nötig —
die Teams-Karte erinnert rechtzeitig).</p>
<form method="post" action="/linkedin/start">
  <label>Client-ID</label>
  <input type="text" name="clientId" value="${esc(env.LINKEDIN_CLIENT_ID ?? "78s5jdboo592ss")}" required>
  <label>Client-Secret</label>
  <input type="password" name="clientSecret" value="${esc(env.LINKEDIN_CLIENT_SECRET ?? "")}" required>
  <button type="submit">Bei LinkedIn anmelden &amp; autorisieren →</button>
</form>`,
  );
}

async function linkedinExchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<PendingLinkedIn["tokens"]> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
  const res = await httpPost("https://www.linkedin.com/oauth/v2/accessToken", body, {
    contentType: "application/x-www-form-urlencoded",
    retries: 0,
  });
  if (res.status !== 200) {
    throw new Error(`LinkedIn Code-Tausch: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const data = parseJson<{
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  }>(res.body, "LinkedIn Code-Tausch");
  if (!data.access_token) throw new Error("LinkedIn Code-Tausch: Antwort ohne access_token");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    refreshExpiresIn: data.refresh_token_expires_in,
  };
}

async function linkedinDiscoverOrgs(accessToken: string): Promise<string[]> {
  try {
    const res = await httpGet("https://api.linkedin.com/rest/organizationAcls?q=roleAssignee", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      retries: 0,
    });
    if (res.status !== 200) return [];
    const data = parseJson<{ elements?: { organization?: string }[] }>(
      res.body,
      "LinkedIn organizationAcls",
    );
    return (data.elements ?? [])
      .map((e) => e.organization)
      .filter((o): o is string => typeof o === "string");
  } catch {
    return []; // Discovery ist Komfort — Fallback ist das manuelle Feld.
  }
}

function linkedinFinishPage(nonce: string, p: PendingLinkedIn): string {
  const days = p.tokens.refreshExpiresIn
    ? Math.floor(p.tokens.refreshExpiresIn / 86400)
    : undefined;
  const orgChoices = p.orgs.length
    ? p.orgs
        .map(
          (urn, i) =>
            `<label style="font-weight:400"><input type="radio" name="organizationUrn" value="${esc(urn)}" ${i === 0 ? "checked" : ""}> <code>${esc(urn)}</code></label>`,
        )
        .join("")
    : `<label>Organisation-URN (nicht automatisch gefunden — numerische ID aus
       der Admin-URL <code>linkedin.com/company/&lt;ID&gt;/admin/</code>)</label>
       <input type="text" name="organizationUrn" placeholder="urn:li:organization:123456" required>`;
  return page(
    "LinkedIn — fast fertig",
    `
<p class="ok">✅ Token erhalten${p.tokens.refreshToken ? " (inkl. Refresh-Token — Auto-Refresh aktiv)" : ""}${days ? `, Re-Consent in ~${days} Tagen` : ""}.</p>
${p.tokens.refreshToken ? "" : '<p class="warn">⚠️ Kein Refresh-Token in der Antwort — prüfe, ob die App für „Refresh Tokens" freigeschaltet ist. Ohne ihn muss der Token alle 60 Tage manuell erneuert werden.</p>'}
<form method="post" action="/linkedin/finish">
  <input type="hidden" name="nonce" value="${esc(nonce)}">
  <h2>Organisation wählen</h2>
  ${orgChoices}
  <label style="font-weight:400;margin-top:1rem"><input type="checkbox" name="enable" checked> Plattform aktivieren (Polling ein)</label>
  <button type="submit">Speichern → .env + platforms.yaml</button>
</form>`,
  );
}

// ---------------------------------------------------------------- Meta

function metaFormPage(msg?: string): string {
  return page(
    "Facebook & Instagram einrichten",
    `
${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<p>Meta bietet keinen Refresh-Flow — der Weg zu „nie wieder anfassen" ist ein
<b>System-User-Token</b> (Business Manager → System User → Assets zuweisen →
Token generieren, „Never expires"). Schritt-für-Schritt: docs/TOKENS.md.</p>
<p>Diese <b>sechs Scopes</b> beim Generieren ankreuzen:</p>
<ul>
<li><code>pages_show_list</code> — ohne diesen findet der Wizard unten keine Seite</li>
<li><code>business_management</code> — Zugriff auf die Assets des Business-Portfolios</li>
<li><code>pages_read_engagement</code> — Beiträge der Seite lesen</li>
<li><code>pages_read_user_content</code> — Kommentare anderer Personen lesen</li>
<li><code>instagram_basic</code> — Instagram-Beiträge lesen</li>
<li><code>instagram_manage_comments</code> — Instagram-Kommentare lesen</li>
</ul>
<p>Token unten einfügen — der Wizard validiert ihn und findet Page-ID und
IG-Business-Konto automatisch.</p>
<form method="post" action="/meta/pages">
  <label>System-User-Token (oder long-lived Page-Token)</label>
  <input type="password" name="token" required>
  <button type="submit">Token prüfen &amp; Pages suchen →</button>
</form>`,
  );
}

async function metaDiscoverPages(token: string): Promise<PendingMeta["pages"]> {
  const url =
    `${GRAPH_BASE}/me/accounts` +
    `?fields=id,name,access_token,instagram_business_account{id,username}&limit=25`;
  const res = await httpGet(url, { headers: { Authorization: `Bearer ${token}` }, retries: 0 });
  if (res.status !== 200) {
    throw new Error(`Graph me/accounts: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const data = parseJson<{
    data?: {
      id?: string;
      name?: string;
      access_token?: string;
      instagram_business_account?: { id?: string; username?: string };
    }[];
  }>(res.body, "Graph me/accounts");
  return (data.data ?? [])
    .filter((p): p is typeof p & { id: string } => typeof p.id === "string")
    .map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      accessToken: p.access_token,
      igId: p.instagram_business_account?.id,
      igName: p.instagram_business_account?.username,
    }));
}

function metaChoosePage(nonce: string, p: PendingMeta): string {
  const rows = p.pages
    .map(
      (pg, i) => `
<label style="font-weight:400"><input type="radio" name="pageId" value="${esc(pg.id)}" ${i === 0 ? "checked" : ""}>
 <b>${esc(pg.name)}</b> (Page-ID ${esc(pg.id)}) —
 ${pg.igId ? `Instagram: <b>@${esc(pg.igName ?? pg.igId)}</b> ✅` : '<span class="warn">kein IG-Business-Konto verknüpft</span>'}</label>`,
    )
    .join("");
  return page(
    "Meta — Page wählen",
    `
<p class="ok">✅ Token gültig, ${p.pages.length} Page(s) gefunden.</p>
<form method="post" action="/meta/finish">
  <input type="hidden" name="nonce" value="${esc(nonce)}">
  ${rows}
  <label style="font-weight:400;margin-top:1rem"><input type="checkbox" name="enableFacebook" checked> Facebook aktivieren</label>
  <label style="font-weight:400"><input type="checkbox" name="enableInstagram" checked> Instagram aktivieren (nur wirksam, wenn IG verknüpft ist)</label>
  <button type="submit">Speichern → .env + platforms.yaml</button>
</form>
<p class="muted">Der Wizard übernimmt den page-spezifischen Token aus der
Antwort (bei System-Usern läuft der nicht ab).</p>`,
  );
}

// ---------------------------------------------------------------- TikTok

function tiktokFormPage(msg?: string): string {
  const env = readEnvFile(ENV_PATH);
  return page(
    "TikTok einrichten",
    `
${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<p>TikTok erlaubt keine localhost-Redirects, daher Paste-Modus: Consent-Flow
einmal im TikTok-Developer-Portal durchführen (Login Kit, Scope
<code>video.list</code> — Anleitung in docs/TOKENS.md) und die Werte hier
einfügen. Der Wizard <b>validiert den Refresh-Token sofort per echtem
Refresh</b> und übernimmt den dabei rotierten neuen Token automatisch —
danach hält der Poller die Kette am Leben.</p>
<p class="warn">Hinweis: Kommentare kann TikTok nicht liefern (Plattform-
Beschränkung); es werden nur neue Videos gemeldet.</p>
<form method="post" action="/tiktok/finish">
  <label>Client-Key</label>
  <input type="text" name="clientKey" value="${esc(env.TIKTOK_CLIENT_KEY ?? "")}" required>
  <label>Client-Secret</label>
  <input type="password" name="clientSecret" value="${esc(env.TIKTOK_CLIENT_SECRET ?? "")}" required>
  <label>Refresh-Token (aus dem Consent-Flow)</label>
  <input type="password" name="refreshToken" required>
  <label style="font-weight:400;margin-top:1rem"><input type="checkbox" name="enable" checked> Plattform aktivieren</label>
  <button type="submit">Validieren &amp; speichern</button>
</form>`,
  );
}

async function tiktokValidateRefresh(
  clientKey: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; refreshExpiresIn?: number }> {
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }).toString();
  const res = await httpPost("https://open.tiktokapis.com/v2/oauth/token/", body, {
    contentType: "application/x-www-form-urlencoded",
    retries: 0,
  });
  const data = parseJson<{
    access_token?: string;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  }>(res.body, "TikTok token refresh");
  if (res.status !== 200 || data.error || !data.access_token) {
    throw new Error(
      `TikTok-Validierung fehlgeschlagen: ${data.error ?? `HTTP ${res.status}`}: ${data.error_description ?? res.body.slice(0, 150)}`,
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    refreshExpiresIn: data.refresh_token_expires_in,
  };
}

// ---------------------------------------------------------------- Router

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/") return send(res, overviewPage());

  // ---- LinkedIn ----
  if (req.method === "GET" && path === "/linkedin") return send(res, linkedinFormPage());

  if (req.method === "POST" && path === "/linkedin/start") {
    const form = await readBody(req);
    const clientId = form.get("clientId")?.trim() ?? "";
    const clientSecret = form.get("clientSecret")?.trim() ?? "";
    if (!clientId || !clientSecret) return send(res, linkedinFormPage("Client-ID/Secret fehlen."));
    updateEnvFile(ENV_PATH, { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_CLIENT_SECRET: clientSecret });
    oauthState = randomBytes(16).toString("hex");
    const authorize =
      "https://www.linkedin.com/oauth/v2/authorization" +
      `?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${oauthState}&scope=${encodeURIComponent("r_organization_social")}`;
    return redirect(res, authorize);
  }

  if (req.method === "GET" && path === "/callback/linkedin") {
    const err = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (err) return send(res, linkedinFormPage(`LinkedIn meldet: ${err}`));
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.get("state") !== oauthState) {
      return send(res, linkedinFormPage("Ungültiger Callback (state/code) — bitte neu starten."));
    }
    const env = readEnvFile(ENV_PATH);
    try {
      const tokens = await linkedinExchangeCode(
        code,
        env.LINKEDIN_CLIENT_ID ?? "",
        env.LINKEDIN_CLIENT_SECRET ?? "",
      );
      const orgs = await linkedinDiscoverOrgs(tokens.accessToken);
      const nonce = randomBytes(8).toString("hex");
      pending.set(nonce, { tokens, orgs });
      return send(res, linkedinFinishPage(nonce, { tokens, orgs }));
    } catch (e) {
      return send(res, linkedinFormPage((e as Error).message));
    }
  }

  if (req.method === "POST" && path === "/linkedin/finish") {
    const form = await readBody(req);
    const p = pending.get(form.get("nonce") ?? "");
    if (!p || !("tokens" in p)) return redirect(res, "/linkedin");
    const urn = form.get("organizationUrn")?.trim() ?? "";
    if (!urn.startsWith("urn:li:organization:")) {
      return send(res, linkedinFormPage("Organisation-URN fehlt/ungültig — bitte neu starten."));
    }
    updateEnvFile(ENV_PATH, {
      LINKEDIN_ACCESS_TOKEN: p.tokens.accessToken,
      ...(p.tokens.refreshToken ? { LINKEDIN_REFRESH_TOKEN: p.tokens.refreshToken } : {}),
    });
    updatePlatformsYaml(CONFIG_PATH, EXAMPLE_PATH, "linkedin", {
      enabled: form.get("enable") !== null,
      removeTokenExpiresAt: Boolean(p.tokens.refreshToken),
      options: {
        organizationUrn: urn,
        tokenEnv: "LINKEDIN_ACCESS_TOKEN",
        ...(p.tokens.refreshToken
          ? {
              refresh: {
                refreshTokenEnv: "LINKEDIN_REFRESH_TOKEN",
                clientIdEnv: "LINKEDIN_CLIENT_ID",
                clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
              },
            }
          : {}),
      },
    });
    pending.clear();
    return redirect(res, "/");
  }

  // ---- Meta ----
  if (req.method === "GET" && path === "/meta") return send(res, metaFormPage());

  if (req.method === "POST" && path === "/meta/pages") {
    const form = await readBody(req);
    const token = form.get("token")?.trim() ?? "";
    if (!token) return send(res, metaFormPage("Token fehlt."));
    try {
      const pages = await metaDiscoverPages(token);
      if (pages.length === 0) {
        return send(
          res,
          metaFormPage(
            "Token gültig, aber keine Seite gefunden. Zwei häufige Ursachen: " +
              "(1) der Scope pages_show_list bzw. business_management fehlt beim Token, " +
              "(2) dem System-User ist die Facebook-Seite nicht als Asset zugewiesen.",
          ),
        );
      }
      const nonce = randomBytes(8).toString("hex");
      pending.set(nonce, { token, pages });
      return send(res, metaChoosePage(nonce, { token, pages }));
    } catch (e) {
      return send(res, metaFormPage((e as Error).message));
    }
  }

  if (req.method === "POST" && path === "/meta/finish") {
    const form = await readBody(req);
    const p = pending.get(form.get("nonce") ?? "");
    if (!p || !("pages" in p)) return redirect(res, "/meta");
    const chosen = p.pages.find((pg) => pg.id === form.get("pageId"));
    if (!chosen) return send(res, metaFormPage("Keine Page gewählt — bitte neu starten."));
    // Page-spezifischer Token, falls vorhanden (System-User → läuft nie ab).
    const token = chosen.accessToken ?? p.token;
    updateEnvFile(ENV_PATH, { FACEBOOK_PAGE_TOKEN: token, INSTAGRAM_ACCESS_TOKEN: token });
    updatePlatformsYaml(CONFIG_PATH, EXAMPLE_PATH, "facebook", {
      enabled: form.get("enableFacebook") !== null,
      options: { pageId: chosen.id, tokenEnv: "FACEBOOK_PAGE_TOKEN" },
    });
    if (chosen.igId) {
      updatePlatformsYaml(CONFIG_PATH, EXAMPLE_PATH, "instagram", {
        enabled: form.get("enableInstagram") !== null,
        options: { igUserId: chosen.igId, tokenEnv: "INSTAGRAM_ACCESS_TOKEN" },
      });
    }
    pending.clear();
    return redirect(res, "/");
  }

  // ---- TikTok ----
  if (req.method === "GET" && path === "/tiktok") return send(res, tiktokFormPage());

  if (req.method === "POST" && path === "/tiktok/finish") {
    const form = await readBody(req);
    const clientKey = form.get("clientKey")?.trim() ?? "";
    const clientSecret = form.get("clientSecret")?.trim() ?? "";
    const refreshToken = form.get("refreshToken")?.trim() ?? "";
    if (!clientKey || !clientSecret || !refreshToken) {
      return send(res, tiktokFormPage("Alle drei Felder sind nötig."));
    }
    try {
      const result = await tiktokValidateRefresh(clientKey, clientSecret, refreshToken);
      updateEnvFile(ENV_PATH, {
        TIKTOK_CLIENT_KEY: clientKey,
        TIKTOK_CLIENT_SECRET: clientSecret,
        TIKTOK_REFRESH_TOKEN: result.refreshToken, // der ROTIERTE Token!
        TIKTOK_ACCESS_TOKEN: result.accessToken,
      });
      updatePlatformsYaml(CONFIG_PATH, EXAMPLE_PATH, "tiktok", {
        enabled: form.get("enable") !== null,
        options: {
          tokenEnv: "TIKTOK_ACCESS_TOKEN",
          refresh: {
            refreshTokenEnv: "TIKTOK_REFRESH_TOKEN",
            clientIdEnv: "TIKTOK_CLIENT_KEY",
            clientSecretEnv: "TIKTOK_CLIENT_SECRET",
          },
        },
      });
      return redirect(res, "/");
    } catch (e) {
      return send(res, tiktokFormPage((e as Error).message));
    }
  }

  send(res, page("Nicht gefunden", '<p><a href="/">Zur Übersicht</a></p>'), 404);
}

export function runSetup(): void {
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      send(res, page("Fehler", `<p class="err">${esc((err as Error).message)}</p>`), 500);
    });
  });
  // Default: NUR localhost (SSH-Tunnel). Im Container: SETUP_BIND=0.0.0.0,
  // aber ausschließlich hinter einem authentifizierenden Proxy (Caddy basic_auth).
  server.listen(PORT, BIND, () => {
    const tunnelHint =
      BIND === "127.0.0.1"
        ? `Auf einem Server: lokal \`ssh -L ${PORT}:localhost:${PORT} <server>\` starten.\n`
        : `⚠️  Bind ${BIND} — nur hinter einem authentifizierenden Reverse-Proxy betreiben!\n`;
    process.stdout.write(
      `\nsocial-to-chat Setup-Wizard läuft:\n\n` +
        `    ${PUBLIC_URL}\n\n` +
        tunnelHint +
        `LinkedIn-Redirect-URI (in der App registrieren): ${REDIRECT_URI}\n` +
        `Beenden mit Ctrl+C.\n\n`,
    );
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
