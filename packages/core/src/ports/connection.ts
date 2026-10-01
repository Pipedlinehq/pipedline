/**
 * A venue's link to an outside service, with its credentials resolved. Built by
 * loadConnection() (packages/core/src/connections.ts); adapters receive it and never see the
 * database or the secret store.
 */
export interface ConnectionHandle {
  id: string;
  orgId: string;
  venueId: string | null;
  plugKey: string;
  externalAccountId: string;
  scopes: string[];
  config: Record<string, unknown>;
  credentials: Record<string, string>;
}

export interface WebhookVerifyArgs {
  rawBody: string;
  headers: Record<string, string | undefined>;
  /** The full URL the provider called, which some providers sign. */
  url: string;
  signingSecret: string;
}
