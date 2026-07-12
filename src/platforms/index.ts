import type { PlatformConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import type { SocialProvider } from "./types.js";
import { LinkedInProvider } from "./linkedin.js";
import { FacebookProvider } from "./facebook.js";
import { InstagramProvider } from "./instagram.js";
import { TikTokProvider } from "./tiktok.js";

/**
 * Adapter-Registry. Neue Plattform hinzufügen:
 *   1. Datei anlegen, die SocialProvider implementiert
 *   2. hier importieren + case ergänzen
 *   3. Eintrag in config/platforms.yaml
 */
export function createProvider(cfg: PlatformConfig, log: Logger): SocialProvider {
  const scoped = log.child({ provider: cfg.key, platform: cfg.platform });
  switch (cfg.platform) {
    case "linkedin":
      return new LinkedInProvider(cfg, scoped);
    case "facebook":
      return new FacebookProvider(cfg, scoped);
    case "instagram":
      return new InstagramProvider(cfg, scoped);
    case "tiktok":
      return new TikTokProvider(cfg, scoped);
    default: {
      const _exhaustive: never = cfg.platform;
      throw new Error(`Unbekannte Plattform: ${String(_exhaustive)}`);
    }
  }
}
