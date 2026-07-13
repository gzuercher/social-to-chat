import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
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
 *   Stats:         GET /{media-id}/insights + like_count/comments_count
 *
 * options:
 *   igUserId: "..."
 *   tokenEnv: "INSTAGRAM_ACCESS_TOKEN"
 */
export class InstagramProvider implements SocialProvider {
  readonly platform = "instagram" as const;
  readonly key: string;

  constructor(
    private readonly cfg: PlatformConfig,
    private readonly log: Logger,
  ) {
    this.key = cfg.key;
  }

  async fetchPosts(): Promise<SocialEvent[]> {
    // TODO(Priorität 1): media im Sichtfenster abrufen und in SocialEvent
    // (type "post") mappen — ungefiltert, Dedup macht der Loop.
    this.log.warn("Instagram fetchPosts: noch nicht implementiert");
    return [];
  }

  async fetchComments(_posts: PostRef[]): Promise<SocialEvent[]> {
    // TODO(Priorität 2): comments je übergebenem media-Post abrufen und in
    // SocialEvent (type "comment") mappen.
    this.log.warn("Instagram fetchComments: noch nicht implementiert");
    return [];
  }

  async fetchStats(_externalIds: string[]): Promise<SocialStats[]> {
    // TODO(Priorität 3): insights → likes/comments/views(reach).
    this.log.warn("Instagram fetchStats: noch nicht implementiert");
    return [];
  }
}
