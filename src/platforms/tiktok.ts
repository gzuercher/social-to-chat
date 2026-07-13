import { z } from "zod";
import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { httpPost } from "../lib/httpClient.js";
import { parseJson } from "../lib/json.js";
import type { PostRef, SocialEvent, SocialProvider, SocialStats } from "./types.js";

/**
 * TikTok-Adapter.
 *
 * WICHTIG — Plattform-Beschränkung (Stand 2026-07):
 *   • Neue Videos/Posts listen:  ✅ möglich (Display API, video/list)
 *   • Kommentare LESEN:          ❌ NICHT möglich. TikTok bietet keine öffentliche
 *     Kommentar-Lese-API; nur die Research API (nur für akademische Zwecke)
 *     liefert Kommentare. Kein DIY- und kein SaaS-Weg umgeht das zuverlässig.
 *   • Kennzahlen (Views/Likes/Comment-COUNTS): ✅ möglich (nur Zahlen, kein Text).
 *
 * Daher: fetchComments() gibt bewusst und dauerhaft [] zurück.
 *
 * API: TikTok Display API. Scope: video.list. Access-Tokens sind nur 24 h
 * gültig (Refresh-Token 365 Tage) — ein statisches Token in der ENV taugt
 * nur für Tests; produktiv braucht dieser Adapter noch einen Refresh-Flow
 * (siehe TODO unten).
 *
 * HINWEIS Live-Verifikation: Implementiert nach API-Doku, noch nicht gegen
 * die echte API getestet.
 *
 * options:
 *   tokenEnv: "TIKTOK_ACCESS_TOKEN"
 */

const optionsSchema = z.object({
  tokenEnv: z.string().min(1),
  // openId ist für video/list nicht nötig (Token ist nutzergebunden), bleibt
  // aber als dokumentierendes Feld erlaubt.
  openId: z.string().optional(),
});

const API_BASE = "https://open.tiktokapis.com/v2";
const VIDEO_FIELDS = "id,title,video_description,create_time,share_url";
const PAGE_SIZE = 20;

type TikTokVideo = {
  id?: string;
  title?: string;
  video_description?: string;
  create_time?: number;
  share_url?: string;
};

type VideoListResponse = {
  data?: { videos?: TikTokVideo[] };
  error?: { code?: string; message?: string };
};

export class TikTokProvider implements SocialProvider {
  readonly platform = "tiktok" as const;
  readonly key: string;
  private readonly tokenEnv: string;

  constructor(
    private readonly cfg: PlatformConfig,
    private readonly log: Logger,
  ) {
    this.key = cfg.key;
    const parsed = optionsSchema.safeParse(cfg.options);
    if (!parsed.success) {
      throw new Error(`${cfg.key}: ungültige TikTok-options: ${parsed.error.message}`);
    }
    this.tokenEnv = parsed.data.tokenEnv;
  }

  private headers(): Record<string, string> {
    // TODO: Refresh-Flow (24h-Access-Token via Refresh-Token erneuern),
    // bevor TikTok produktiv aktiviert wird.
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`${this.key}: ENV ${this.tokenEnv} ist nicht gesetzt`);
    return { Authorization: `Bearer ${token}` };
  }

  /** Die jüngsten Videos des Kontos (eine Seite, ungefiltert). */
  async fetchPosts(): Promise<SocialEvent[]> {
    const url = `${API_BASE}/video/list/?fields=${encodeURIComponent(VIDEO_FIELDS)}`;
    const res = await httpPost(url, { max_count: PAGE_SIZE }, { headers: this.headers() });
    if (res.status !== 200) {
      throw new Error(`TikTok video/list: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    const data = parseJson<VideoListResponse>(res.body, "TikTok video/list");
    if (data.error?.code && data.error.code !== "ok") {
      throw new Error(`TikTok video/list: ${data.error.code}: ${data.error.message ?? ""}`);
    }
    const author = this.cfg.name || this.key;

    return (data.data?.videos ?? [])
      .filter((v): v is TikTokVideo & { id: string } => typeof v.id === "string")
      .map((v) => ({
        schemaVersion: 1 as const,
        source: "social" as const,
        platform: this.platform,
        type: "post" as const,
        externalId: v.id,
        author,
        text: v.video_description ?? v.title ?? "",
        context: "",
        url: v.share_url ?? "https://www.tiktok.com/",
        timestamp: new Date((v.create_time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      }));
  }

  async fetchComments(_posts: PostRef[]): Promise<SocialEvent[]> {
    // Bewusst leer: TikTok hat keine Kommentar-Lese-API (siehe Datei-Header).
    return [];
  }

  async fetchStats(_externalIds: string[]): Promise<SocialStats[]> {
    // Priorität 3 — Contract noch undesignt, bewusst nicht implementiert.
    this.log.warn("TikTok fetchStats: noch nicht implementiert (P3 geparkt)");
    return [];
  }
}
