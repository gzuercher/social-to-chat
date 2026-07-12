import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import type { SocialEvent, SocialProvider, SocialStats } from "./types.js";

/**
 * Facebook-Page-Adapter.
 *
 * API: Meta Graph API (Page). Braucht Page Access Token (langlebig) mit
 *      pages_read_engagement / pages_read_user_content.
 * Polling ODER Webhook möglich — hier Polling (analog zu den anderen Adaptern).
 * (Eine Push-Variante existiert als Logic App feeds/social-facebook im
 *  msteams-feeds-automate-Repo, ist aber pausiert.)
 *
 * Endpunkte:
 *   Posts:      GET /{page-id}/published_posts?fields=id,message,permalink_url,created_time
 *   Kommentare: GET /{post-id}/comments?fields=id,message,from,permalink_url,created_time
 *   Stats:      GET /{post-id}/insights + likes/comments/shares summary
 *
 * options:
 *   pageId:   "..."
 *   tokenEnv: "FACEBOOK_PAGE_TOKEN"
 */
export class FacebookProvider implements SocialProvider {
  readonly platform = "facebook" as const;
  readonly key: string;

  constructor(
    private readonly cfg: PlatformConfig,
    private readonly log: Logger,
  ) {
    this.key = cfg.key;
  }

  async fetchNewPosts(): Promise<SocialEvent[]> {
    // TODO(Priorität 1): published_posts abrufen, neue in SocialEvent (type "post") mappen.
    this.log.warn("Facebook fetchNewPosts: noch nicht implementiert");
    return [];
  }

  async fetchNewComments(): Promise<SocialEvent[]> {
    // TODO(Priorität 2): comments je Post abrufen, neue in SocialEvent (type "comment") mappen.
    this.log.warn("Facebook fetchNewComments: noch nicht implementiert");
    return [];
  }

  async fetchStats(_externalIds: string[]): Promise<SocialStats[]> {
    // TODO(Priorität 3): insights/summary → likes/comments/shares.
    this.log.warn("Facebook fetchStats: noch nicht implementiert");
    return [];
  }
}
