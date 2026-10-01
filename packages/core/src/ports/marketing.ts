import type { ConnectionHandle } from './connection';

/**
 * Server-side conversions to an ad platform. Only for guests who hold the
 * 'ad_platform_sharing' consent; identifiers are hashed before they leave; a card identifier
 * never goes.
 */
export interface AdsConversion {
  eventId: string;
  eventName: 'Purchase' | 'Lead' | 'CompleteRegistration';
  occurredAt: Date;
  valueCents?: number;
  currency?: string;
  /** SHA-256 of the normalised value, as the platform requires. */
  hashedEmail?: string | null;
  hashedPhone?: string | null;
  source: 'website' | 'physical_store';
  /** Our order or sale reference, for platforms that de-duplicate on it. Never a card identifier. */
  orderId?: string | null;
}

export interface AdsAdapter {
  key: string;
  sendConversions(conn: ConnectionHandle, conversions: AdsConversion[]): Promise<{ accepted: number }>;
}

export interface ExternalReview {
  externalId: string;
  rating: number | null;
  body: string | null;
  authorName: string | null;
  reviewedAt: Date;
  replyBody?: string | null;
  raw?: unknown;
}

export interface ReviewsAdapter {
  key: string;
  listReviews(conn: ConnectionHandle, args: { since?: Date; cursor?: string | null }): Promise<{ items: ExternalReview[]; nextCursor: string | null }>;
  reply(conn: ConnectionHandle, args: { externalId: string; body: string; idempotencyKey: string }): Promise<{ ok: boolean }>;
  /** Daily listing insights (directions, calls, searches, website clicks), when the provider has them. */
  insights?(conn: ConnectionHandle, args: { since: Date; until: Date }): Promise<Array<{ day: string; directions: number; calls: number; searches: number; websiteClicks: number }>>;
}
