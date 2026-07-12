import type { Logger } from "../lib/logger.js";
import { httpJson } from "../lib/httpClient.js";
import type { Notifier, SocialEvent } from "../platforms/types.js";

/**
 * Verschickt ein SocialEvent per HTTP-POST an einen konfigurierbaren Webhook.
 *
 * Bei Raptus zeigt dieser Webhook auf die Logic App `social-feed`
 * (Repo msteams-feeds-automate), die daraus zentral die Teams-Adaptive-Card
 * rendert. Der Body ist exakt der social-feed-Contract — hier wird `externalId`
 * (nur intern für Dedup) vor dem Senden entfernt.
 */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly log: Logger,
  ) {}

  async send(event: SocialEvent): Promise<void> {
    // `externalId` ist nur intern (Dedup) und gehört nicht in den Contract.
    const { externalId, ...contract } = event;
    void externalId;
    const res = await httpJson(this.webhookUrl, { method: "POST", body: contract });
    if (res.statusCode >= 300) {
      throw new Error(`Webhook antwortete ${res.statusCode}: ${res.body.slice(0, 200)}`);
    }
    this.log.info(
      { platform: event.platform, type: event.type, statusCode: res.statusCode },
      "event gesendet",
    );
  }
}
