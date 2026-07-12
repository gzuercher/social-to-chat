import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import type { SocialEvent, SocialProvider, SocialStats } from "./types.js";

/**
 * TikTok-Adapter.
 *
 * WICHTIG — Plattform-Beschränkung (Stand 2026-07):
 *   • Neue Videos/Posts listen:  ✅ möglich (Display API / Content Posting API)
 *   • Kommentare LESEN:          ❌ NICHT möglich. TikTok bietet keine öffentliche
 *     Kommentar-Lese-API; nur die Research API (nur für akademische Zwecke)
 *     liefert Kommentare. Kein DIY- und kein SaaS-Weg umgeht das zuverlässig.
 *   • Kennzahlen (Views/Likes/Comment-COUNTS): ✅ möglich (nur Zahlen, kein Text).
 *
 * Daher: fetchNewComments() gibt bewusst und dauerhaft [] zurück.
 *
 * API: TikTok Display API / Business API. Scopes: video.list, (video.insights).
 * options:
 *   openId / businessId: "..."
 *   tokenEnv:            "TIKTOK_ACCESS_TOKEN"
 */
export class TikTokProvider implements SocialProvider {
  readonly platform = "tiktok" as const;
  readonly key: string;

  constructor(
    private readonly cfg: PlatformConfig,
    private readonly log: Logger,
  ) {
    this.key = cfg.key;
  }

  async fetchNewPosts(): Promise<SocialEvent[]> {
    // TODO(Priorität 1): video.list abrufen, neue in SocialEvent (type "post") mappen.
    this.log.warn("TikTok fetchNewPosts: noch nicht implementiert");
    return [];
  }

  async fetchNewComments(): Promise<SocialEvent[]> {
    // Bewusst leer: TikTok hat keine Kommentar-Lese-API (siehe Datei-Header).
    return [];
  }

  async fetchStats(_externalIds: string[]): Promise<SocialStats[]> {
    // TODO(Priorität 3): video insights → views/likes/comments(count)/shares.
    this.log.warn("TikTok fetchStats: noch nicht implementiert");
    return [];
  }
}
