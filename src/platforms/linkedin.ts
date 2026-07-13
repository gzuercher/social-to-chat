import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import type { PostRef, SocialEvent, SocialProvider, SocialStats } from "./types.js";

/**
 * LinkedIn-Adapter (Organisation/Company Page).
 *
 * API: LinkedIn Marketing / Community Management API.
 * Scope: `r_organization_social` (auf App "SoloPostics", Client 78s5jdboo592ss
 *        bereits vorhanden und bestätigt). Tokens 60 Tage gültig → Refresh nötig.
 * Kein Push → Polling. Dedup über Post-URN / Kommentar-ID.
 *
 * Endpunkte (Umsetzung Priorität 1 → 2 → 3):
 *   Posts:     GET /rest/posts?author={org-urn}&q=author         (Priorität 1)
 *   Kommentare: GET /rest/socialActions/{share-urn}/comments      (Priorität 2)
 *   Stats:     GET /rest/organizationalEntityShareStatistics ...  (Priorität 3)
 *
 * options (aus config/platforms.yaml):
 *   organizationUrn: "urn:li:organization:XXXXXXXX"
 *   tokenEnv:        "LINKEDIN_ACCESS_TOKEN"   (Name der ENV mit dem Token)
 */
export class LinkedInProvider implements SocialProvider {
  readonly platform = "linkedin" as const;
  readonly key: string;

  constructor(
    private readonly cfg: PlatformConfig,
    private readonly log: Logger,
  ) {
    this.key = cfg.key;
  }

  async fetchPosts(): Promise<SocialEvent[]> {
    // TODO(Priorität 1): Posts der Organisation im Sichtfenster abrufen und in
    // SocialEvent (type "post") mappen — ungefiltert, Dedup macht der Loop.
    // Token aus process.env[options.tokenEnv].
    this.log.warn("LinkedIn fetchPosts: noch nicht implementiert");
    return [];
  }

  async fetchComments(_posts: PostRef[]): Promise<SocialEvent[]> {
    // TODO(Priorität 2): socialActions/Kommentare je übergebenem Post abrufen,
    // in SocialEvent (type "comment", context = post.text-Auszug) mappen.
    this.log.warn("LinkedIn fetchComments: noch nicht implementiert");
    return [];
  }

  async fetchStats(_externalIds: string[]): Promise<SocialStats[]> {
    // TODO(Priorität 3): organizationalEntityShareStatistics → likes/comments/shares/views.
    this.log.warn("LinkedIn fetchStats: noch nicht implementiert");
    return [];
  }
}
