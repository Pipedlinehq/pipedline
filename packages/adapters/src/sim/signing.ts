import { hmacHex, safeEqual, type WebhookVerifyArgs } from '@ros/core';

/** Simulated providers sign webhooks the way real ones do: an HMAC of the raw body in a header. */
export const SIM_SIGNATURE_HEADER = 'x-sim-signature';

export function simSign(secret: string, rawBody: string): string {
  return hmacHex(secret, rawBody);
}

export function simVerify(args: WebhookVerifyArgs): boolean {
  const given = args.headers[SIM_SIGNATURE_HEADER];
  if (!given) return false;
  return safeEqual(given, simSign(args.signingSecret, args.rawBody));
}

export function signedWebhook(secret: string, payload: unknown): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(payload);
  return { rawBody, headers: { [SIM_SIGNATURE_HEADER]: simSign(secret, rawBody), 'content-type': 'application/json' } };
}
