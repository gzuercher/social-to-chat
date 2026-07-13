import { z } from "zod";
import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { httpGet } from "../lib/httpClient.js";
import { parseJson } from "../lib/json.js";
import type { PostRef, SocialEvent, SocialProvider, SocialStats } from "./types.js";

/**
 * Facebook-Page-Adapter.
 *
 * API: Meta Graph API (Page). Braucht Page Access Token (langlebig) mit
 *      pages_read_engagement / pages_read_user_content.
 * Polling ODER Webhook möglich — hier Polling (analog zu den anderen Adaptern;
 * die pausierte Push-Variante lebt als Logic App feeds/social-facebook im
 * msteams-feeds-automate-Repo).
 *
 * Endpunkte:
 *   Posts:      GET /{page-id}/published_posts?fields=id,message,permalink_url,created_time
 *   Kommentare: GET /{post-id}/comments?fields=id,message,from,permalink_url,created_time
 *   Stats:      GET /{post-id}/insights (P3, geparkt)
 *
 * HINWEIS Live-Verifikation: Implementiert nach Graph-API-Doku (v23.0),
 * noch nicht gegen die echte API getestet.
 *
 * options:
 *   pageId:   "..."
 *   tokenEnv: "FACEBOOK_PAGE_TOKEN"
 */

const optionsSchema = z.object({
  pageId: z.string().min(1),
  tokenEnv: z.string().min(1),
});

const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const POSTS_PAGE_SIZE = 25;
const COMMENTS_PAGE_SIZE = 50;

type FbPost = {
  id?: string;
  message?: string;
  permalink_url?: string;
  created_time?: string;
};

type FbComment = {
  id?: string;
  message?: string;
  from?: { name?: string };
  permalink_url?: string;
  created_time?: string;
};

export class FacebookProvider implements SocialProvider {
  readonly platform = "facebook" as const;
  readonly key: string;
  private readonly pageId: string;
  private readonly tokenEnv: string;

  constructor(
    private readonly cfg: PlatformConfig,
    private readonly log: Logger,
  ) {
    this.key = cfg.key;
    const parsed = optionsSchema.safeParse(cfg.options);
    if (!parsed.success) {
      throw new Error(`${cfg.key}: ungültige Facebook-options: ${parsed.error.message}`);
    }
    this.pageId = parsed.data.pageId;
    this.tokenEnv = parsed.data.tokenEnv;
  }

  private headers(): Record<string, string> {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`${this.key}: ENV ${this.tokenEnv} ist nicht gesetzt`);
    return { Authorization: `Bearer ${token}` };
  }

  /** Die jüngsten veröffentlichten Page-Posts (eine Seite, ungefiltert). */
  async fetchPosts(): Promise<SocialEvent[]> {
    const url =
      `${GRAPH_BASE}/${this.pageId}/published_posts` +
      `?fields=id,message,permalink_url,created_time&limit=${POSTS_PAGE_SIZE}`;
    const res = await httpGet(url, { headers: this.headers(), accept: "application/json" });
    if (res.status !== 200) {
      throw new Error(`Facebook posts: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    const data = parseJson<{ data?: FbPost[] }>(res.body, "Facebook posts");
    const author = this.cfg.name || this.pageId;

    return (data.data ?? [])
      .filter((p): p is FbPost & { id: string } => typeof p.id === "string")
      .map((p) => ({
        schemaVersion: 1 as const,
        source: "social" as const,
        platform: this.platform,
        type: "post" as const,
        externalId: p.id,
        author,
        text: p.message ?? "",
        context: "",
        url: p.permalink_url ?? `https://www.facebook.com/${p.id}`,
        timestamp: new Date(p.created_time ?? Date.now()).toISOString(),
      }));
  }

  /** Kommentare zu den übergebenen Posts (ein Request je Post). */
  async fetchComments(posts: PostRef[]): Promise<SocialEvent[]> {
    const events: SocialEvent[] = [];
    const errors: unknown[] = [];

    for (const post of posts) {
      try {
        const url =
          `${GRAPH_BASE}/${post.externalId}/comments` +
          `?fields=id,message,from,permalink_url,created_time&limit=${COMMENTS_PAGE_SIZE}`;
        const res = await httpGet(url, { headers: this.headers(), accept: "application/json" });
        if (res.status !== 200) {
          throw new Error(`Facebook comments: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
        }
        const data = parseJson<{ data?: FbComment[] }>(res.body, "Facebook comments");

        for (const c of data.data ?? []) {
          if (typeof c.id !== "string") continue;
          events.push({
            schemaVersion: 1,
            source: "social",
            platform: this.platform,
            type: "comment",
            externalId: c.id,
            // `from` fehlt bei restriktiven Privatsphäre-Einstellungen.
            author: c.from?.name ?? "Facebook-Nutzer",
            text: c.message ?? "",
            context: post.text.slice(0, 100),
            url: c.permalink_url ?? post.url,
            timestamp: new Date(c.created_time ?? Date.now()).toISOString(),
          });
        }
      } catch (err) {
        // Einzelner Post darf den Lauf nicht kippen; scheitern ALLE, muss
        // der Fehler hoch (Token tot → HealthTracker).
        errors.push(err);
        this.log.warn(
          { err, post: post.externalId },
          "Facebook-Kommentare für Post fehlgeschlagen",
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
    this.log.warn("Facebook fetchStats: noch nicht implementiert (P3 geparkt)");
    return [];
  }
}
