import { z } from "zod";
import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { httpGet } from "../lib/httpClient.js";
import { parseJson } from "../lib/json.js";
import type { PostRef, SocialEvent, SocialProvider, SocialStats } from "./types.js";

/**
 * LinkedIn-Adapter (Organisation/Company Page).
 *
 * API: LinkedIn Community Management API (versionierte REST-API).
 * Scope: `r_organization_social` (App "SoloPostics", Client 78s5jdboo592ss).
 * Tokens 60 Tage gültig → `tokenExpiresAt` in der Config pflegen, der
 * Token-Watchdog warnt rechtzeitig.
 *
 * Endpunkte:
 *   Posts:      GET /rest/posts?author={org-urn}&q=author
 *   Kommentare: GET /rest/socialActions/{post-urn}/comments
 *   Stats:      GET /rest/organizationalEntityShareStatistics (P3, geparkt)
 *
 * HINWEIS Live-Verifikation: Implementiert nach API-Doku (Version 202506),
 * aber noch nicht gegen die echte API getestet. Feld-Mapping bei Kommentaren
 * ist defensiv (commentUrn/id, createdAt/created.time), da die Doku hier
 * zwischen Versionen variiert.
 *
 * options (aus config/platforms.yaml):
 *   organizationUrn: "urn:li:organization:XXXXXXXX"
 *   tokenEnv:        "LINKEDIN_ACCESS_TOKEN"   (Name der ENV mit dem Token)
 */

const optionsSchema = z.object({
  organizationUrn: z.string().startsWith("urn:li:organization:"),
  tokenEnv: z.string().min(1),
});

/** Versionsheader der LinkedIn-REST-API (YYYYMM). Bewusst gepinnt. */
const LINKEDIN_VERSION = "202506";
const API_BASE = "https://api.linkedin.com/rest";
const POSTS_PAGE_SIZE = 25;
const COMMENTS_PAGE_SIZE = 50;

type PostElement = {
  id?: string;
  commentary?: string;
  publishedAt?: number;
  createdAt?: number;
};

type CommentElement = {
  commentUrn?: string;
  id?: string | number;
  actor?: string;
  message?: { text?: string };
  createdAt?: number;
  created?: { time?: number };
};

export class LinkedInProvider implements SocialProvider {
  readonly platform = "linkedin" as const;
  readonly key: string;
  private readonly organizationUrn: string;
  private readonly tokenEnv: string;

  constructor(
    private readonly cfg: PlatformConfig,
    private readonly log: Logger,
  ) {
    this.key = cfg.key;
    const parsed = optionsSchema.safeParse(cfg.options);
    if (!parsed.success) {
      throw new Error(`${cfg.key}: ungültige LinkedIn-options: ${parsed.error.message}`);
    }
    this.organizationUrn = parsed.data.organizationUrn;
    this.tokenEnv = parsed.data.tokenEnv;
  }

  private headers(): Record<string, string> {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`${this.key}: ENV ${this.tokenEnv} ist nicht gesetzt`);
    return {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    };
  }

  /** Die jüngsten Posts der Organisation (eine Seite, ungefiltert — Dedup macht der Loop). */
  async fetchPosts(): Promise<SocialEvent[]> {
    const url =
      `${API_BASE}/posts?author=${encodeURIComponent(this.organizationUrn)}` +
      `&q=author&count=${POSTS_PAGE_SIZE}&sortBy=LAST_MODIFIED`;
    const res = await httpGet(url, { headers: this.headers(), accept: "application/json" });
    if (res.status !== 200) {
      throw new Error(`LinkedIn posts: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    const data = parseJson<{ elements?: PostElement[] }>(res.body, "LinkedIn posts");
    const author = this.cfg.name || this.organizationUrn;

    return (data.elements ?? [])
      .filter((el): el is PostElement & { id: string } => typeof el.id === "string")
      .map((el) => ({
        schemaVersion: 1 as const,
        source: "social" as const,
        platform: this.platform,
        type: "post" as const,
        externalId: el.id,
        author,
        text: el.commentary ?? "",
        context: "",
        url: `https://www.linkedin.com/feed/update/${el.id}/`,
        timestamp: new Date(el.publishedAt ?? el.createdAt ?? Date.now()).toISOString(),
      }));
  }

  /** Kommentare zu den übergebenen Posts (ein Request je Post, quota-schonend sequenziell). */
  async fetchComments(posts: PostRef[]): Promise<SocialEvent[]> {
    const events: SocialEvent[] = [];
    const errors: unknown[] = [];

    for (const post of posts) {
      try {
        const url =
          `${API_BASE}/socialActions/${encodeURIComponent(post.externalId)}/comments` +
          `?count=${COMMENTS_PAGE_SIZE}`;
        const res = await httpGet(url, { headers: this.headers(), accept: "application/json" });
        if (res.status !== 200) {
          throw new Error(`LinkedIn comments: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
        }
        const data = parseJson<{ elements?: CommentElement[] }>(res.body, "LinkedIn comments");

        for (const el of data.elements ?? []) {
          const externalId = el.commentUrn ?? (el.id !== undefined ? String(el.id) : undefined);
          if (!externalId) continue;
          events.push({
            schemaVersion: 1,
            source: "social",
            platform: this.platform,
            type: "comment",
            externalId,
            // TODO: Namensauflösung des actor-URN braucht zusätzliche
            // Berechtigungen — bis dahin steht der URN in der Karte.
            author: el.actor ?? "LinkedIn-Mitglied",
            text: el.message?.text ?? "",
            context: post.text.slice(0, 100),
            url: post.url,
            timestamp: new Date(el.createdAt ?? el.created?.time ?? Date.now()).toISOString(),
          });
        }
      } catch (err) {
        // Einzelner Post (z. B. gelöscht) darf den Lauf nicht kippen —
        // aber wenn ALLE scheitern (Token tot), muss der Fehler hoch.
        errors.push(err);
        this.log.warn(
          { err, post: post.externalId },
          "LinkedIn-Kommentare für Post fehlgeschlagen",
        );
      }
    }

    if (posts.length > 0 && errors.length === posts.length) {
      throw errors[0];
    }
    return events;
  }

  async fetchStats(_externalIds: string[]): Promise<SocialStats[]> {
    // Priorität 3 — Contract noch undesignt, bewusst nicht implementiert.
    this.log.warn("LinkedIn fetchStats: noch nicht implementiert (P3 geparkt)");
    return [];
  }
}
