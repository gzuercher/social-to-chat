import type { Logger } from "../lib/logger.js";
import { httpPost } from "../lib/httpClient.js";
import type { Notifier, OpsEvent, SocialEvent } from "../platforms/types.js";

/**
 * Verschickt Social- und Ops-Events per HTTP-POST an einen konfigurierbaren
 * Webhook.
 *
 * Bei Raptus zeigt dieser Webhook auf die Logic App `social-feed`
 * (Repo msteams-feeds-automate), die daraus zentral die Teams-Adaptive-Card
 * rendert. Der Body ist exakt der social-feed-Contract:
 *   • SocialEvent (type "post"/"comment") — `externalId` (nur intern für
 *     Dedup) wird vor dem Senden entfernt.
 *   • OpsEvent (type "ops") — Health-/Token-Meldungen des Pollers selbst,
 *     gehen unverändert raus. Der Chat-Kanal ist zugleich der Alarmkanal.
 *
 * Retry/Backoff übernimmt der httpClient (at-least-once); endgültig
 * fehlgeschlagene Sendungen wirft diese Klasse als Error — der Loop markiert
 * das Event dann nicht als gesehen und versucht es im nächsten Lauf erneut.
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
    await this.post(contract, { platform: event.platform, type: event.type });
  }

  async sendOps(event: OpsEvent): Promise<void> {
    await this.post(event, { platform: event.platform, type: `ops-${event.kind}` });
  }

  private async post(payload: unknown, logContext: Record<string, unknown>): Promise<void> {
    const res = await httpPost(this.webhookUrl, payload);
    if (res.status >= 300) {
      throw new Error(`Webhook antwortete HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    this.log.info({ ...logContext, statusCode: res.status }, "event gesendet");
  }
}
