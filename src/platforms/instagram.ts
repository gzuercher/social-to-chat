import { z } from "zod";
import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { httpGet } from "../lib/httpClient.js";
import { parseJson } from "../lib/json.js";
import type { PostRef, SocialEvent, SocialProvider, SocialStats } from "./types.js";

/**
 * Instagram-Adapter (IG Business / Creator).
 *
 * API: Meta Graph API (Instagram Graph). VORAUSSETZUNG: das IG-Konto muss ein
 *      Business-/Creator-Konto sein UND mit einer Facebook-Page verknüpft sein.
 *      Ohne diese Verknüpfung gibt es keinen API-Zugang.
 * Token: über die verknüpfte Page (pages_read_engagement,
 *        instagram_basic, instagram_manage_comments).
 *
 * Endpunkte:
 *   Posts (Media): GET /{ig-user-id}/media?fields=id,caption,permalink,timestamp
 *   Kommentare:    GET /{media-id}/comments?fields=id,text,username,timestamp
 *   Stats:         GET /{media-id}/insights (P3, geparkt)
 *
 * HINWEIS Live-Verifikation: Implementiert nach Graph-API-Doku (v23.0),
 * noch nicht gegen die echte API getestet.
 *
 * options:
 *   igUserId: "..."
 *   tokenEnv: "INSTAGRAM_ACCESS_TOKEN"
 */

const optionsSchema = z.object({
  igUserId: z.string().min(1),
  tokenEnv: z.string().min(1),
});

const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const POSTS_PAGE_SIZE = 25;
const COMMENTS_PAGE_SIZE = 50;

type IgMedia = {
  id?: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
};

type IgComment = {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
};

export class InstagramProvider implements SocialProvider {
  readonly platform = "instagram" as const;
  readonly key: string;
  private readonly igUserId: string;
  private readonly tokenEnv: string;

  constructor(
    private readonly cfg: PlatformConfig,
    private readonly log: Logger,
  ) {
    this.key = cfg.key;
    const parsed = optionsSchema.safeParse(cfg.options);
    if (!parsed.success) {
      throw new Error(`${cfg.key}: ungültige Instagram-options: ${parsed.error.message}`);
    }
    this.igUserId = parsed.data.igUserId;
    this.tokenEnv = parsed.data.tokenEnv;
  }

  private headers(): Record<string, string> {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`${this.key}: ENV ${this.tokenEnv} ist nicht gesetzt`);
    return { Authorization: `Bearer ${token}` };
  }

  /** Die jüngsten Media-Posts des IG-Business-Kontos (eine Seite, ungefiltert). */
  async fetchPosts(): Promise<SocialEvent[]> {
    const url =
      `${GRAPH_BASE}/${this.igUserId}/media` +
      `?fields=id,caption,permalink,timestamp&limit=${POSTS_PAGE_SIZE}`;
    const res = await httpGet(url, { headers: this.headers(), accept: "application/json" });
    if (res.status !== 200) {
      throw new Error(`Instagram media: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    const data = parseJson<{ data?: IgMedia[] }>(res.body, "Instagram media");
    const author = this.cfg.name || this.igUserId;

    return (data.data ?? [])
      .filter((m): m is IgMedia & { id: string } => typeof m.id === "string")
      .map((m) => ({
        schemaVersion: 1 as const,
        source: "social" as const,
        platform: this.platform,
        type: "post" as const,
        externalId: m.id,
        author,
        text: m.caption ?? "",
        context: "",
        url: m.permalink ?? "https://www.instagram.com/",
        timestamp: new Date(m.timestamp ?? Date.now()).toISOString(),
      }));
  }

  /** Kommentare zu den übergebenen Media-Posts (ein Request je Post). */
  async fetchComments(posts: PostRef[]): Promise<SocialEvent[]> {
    const events: SocialEvent[] = [];
    const errors: unknown[] = [];

    for (const post of posts) {
      try {
        const url =
          `${GRAPH_BASE}/${post.externalId}/comments` +
          `?fields=id,text,username,timestamp&limit=${COMMENTS_PAGE_SIZE}`;
        const res = await httpGet(url, { headers: this.headers(), accept: "application/json" });
        if (res.status !== 200) {
          throw new Error(`Instagram comments: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
        }
        const data = parseJson<{ data?: IgComment[] }>(res.body, "Instagram comments");

        for (const c of data.data ?? []) {
          if (typeof c.id !== "string") continue;
          events.push({
            schemaVersion: 1,
            source: "social",
            platform: this.platform,
            type: "comment",
            externalId: c.id,
            author: c.username ?? "Instagram-Nutzer",
            text: c.text ?? "",
            context: post.text.slice(0, 100),
            // Kommentare haben keinen eigenen Permalink — Link zum Post.
            url: post.url,
            timestamp: new Date(c.timestamp ?? Date.now()).toISOString(),
          });
        }
      } catch (err) {
        // Einzelner Post darf den Lauf nicht kippen; scheitern ALLE, muss
        // der Fehler hoch (Token tot → HealthTracker).
        errors.push(err);
        this.log.warn(
          { err, post: post.externalId },
          "Instagram-Kommentare für Post fehlgeschlagen",
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
    this.log.warn("Instagram fetchStats: noch nicht implementiert (P3 geparkt)");
    return [];
  }
}
