import { createHmac, randomBytes } from 'node:crypto';
import { type RequestStateCodec, createRequestStateCodec } from '@modelcontextprotocol/server';
import { type App, type Ctx, sha256Hex, stableStringify } from '@ros/core';

/**
 * A change waits for the PERSON to say yes (docs/modules/hub.md section 2.4). Ported from
 * Criota's `mcp/confirm.ts`, which is proven on staging and live.
 *
 * The asking is the protocol's own: the tool answers "input required" with the question, the
 * person's assistant shows it to them, and the assistant calls the tool again carrying their
 * answer. No session is kept between the two calls, so any instance can serve either.
 *
 * What travels between the two calls is a signed note (`requestState`), and everything that
 * makes a yes mean what the person was shown is in it or beside it in `agent_confirmations`:
 *   - it is SIGNED with a key only this platform holds (derived from `app.config.signingKey`),
 *     so an assistant cannot write one;
 *   - it is BOUND to the access key and the method, so a yes given to one key is worth nothing
 *     to another;
 *   - it names the TOOL and a digest of the ARGUMENTS the person was asked about, so a yes to
 *     one thing cannot be spent on another;
 *   - it carries a digest of the QUESTION they read. Before the change is made the question is
 *     built again from what is true NOW, and if it would read differently nothing is changed;
 *   - it carries a number used ONCE (`agent_confirmations.spent_at`), so a yes cannot be replayed;
 *   - it EXPIRES: the venue's `write_confirmation_ttl_minutes`, by the platform clock.
 *
 * An assistant that cannot ask its person is refused. There is no fallback to a code the
 * assistant could echo back by itself: that would be the assistant confirming, not the person.
 *
 * The confirmation guards a person against their assistant's mistake. It is not proof that a
 * person answered.
 */

/** What the signed note carries. Nothing in it is secret: it is signed, not sealed. */
export interface ConfirmState {
  /** The tool the person was asked about. */
  tool: string;
  /** A digest of the arguments they were asked about. */
  args: string;
  /** A digest of the QUESTION they were shown: the words, not only the ids. */
  asked: string;
  /** Spent when the change is made. */
  nonce: string;
}

/**
 * The note's own outer limit, by the wall clock, enforced by the SDK's codec. The limit a venue
 * configures is shorter and is enforced from `agent_confirmations.expires_at` by the platform
 * clock, which is what answers "that confirmation has expired" in words.
 */
export const CONFIRM_STATE_MAX_SECONDS = 3600;

/** The question a person was shown, as a digest. */
export function questionDigest(question: string): string {
  return sha256Hex(question);
}

/** The same arguments give the same digest, whatever order their keys came in. */
export function argsDigest(tool: string, args: unknown): string {
  return sha256Hex(`${tool}\0${stableStringify(args ?? {})}`);
}

export function newNonce(): string {
  return randomBytes(18).toString('base64url');
}

const codecs = new WeakMap<App, RequestStateCodec<ConfirmState>>();

/**
 * The codec that signs and verifies the note. Its key is derived from the platform's signing
 * key and separated by purpose, so this key signs nothing but these notes and every instance
 * holds the same one.
 */
export function confirmCodec(app: App): RequestStateCodec<ConfirmState> {
  let codec = codecs.get(app);
  if (!codec) {
    const key = new Uint8Array(createHmac('sha256', app.config.signingKey).update('ros.hub.confirm.v1').digest());
    codec = createRequestStateCodec<ConfirmState>({
      key,
      ttlSeconds: CONFIRM_STATE_MAX_SECONDS,
      // A note minted for one access key, or for another method, does not verify.
      bind: (ctx) => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`,
    });
    codecs.set(app, codec);
  }
  return codec;
}

/** The one thing a person is asked: a box to tick, and the question above it. */
export const CONFIRM_SCHEMA = {
  type: 'object' as const,
  properties: {
    confirm: {
      type: 'boolean' as const,
      title: 'Yes, go ahead',
      description: 'Tick to confirm. Leave unticked, or decline, and nothing is changed.',
      default: false,
    },
  },
  required: ['confirm'],
};

/** What the person answered, read from what the assistant sent back. Untrusted until the note verifies. */
export type Answer = 'yes' | 'no' | 'none';

export function readAnswer(inputResponses: Record<string, unknown> | undefined): Answer {
  if (!inputResponses || !('confirm' in inputResponses)) return 'none';
  const r = inputResponses.confirm as { action?: unknown; content?: { confirm?: unknown } } | null;
  if (r && r.action === 'accept' && r.content && r.content.confirm === true) return 'yes';
  return 'no';
}

/** Whether the assistant said it can put a question to its person. */
export function canAsk(era: 'legacy' | 'modern', clientCapabilities: unknown): boolean {
  // An older-protocol assistant is asked over a connection that is kept open; this server
  // keeps none, so it cannot be reached with a question.
  if (era !== 'modern') return false;
  const caps = clientCapabilities as { elicitation?: { form?: unknown; url?: unknown } | null } | undefined;
  if (!caps || caps.elicitation === undefined || caps.elicitation === null) return false;
  // An empty object means the form kind, by the protocol's own rule.
  const e = caps.elicitation;
  return Object.keys(e).length === 0 || e.form !== undefined;
}

export function consoleUrl(app: App): string {
  return `${app.config.scheme}://${app.config.platformHost}/console`;
}

export function cannotAskMessage(app: App): string {
  return (
    'Nothing was changed. This assistant cannot put a question to you, and no change is made here that you have not been asked about. ' +
    `You can do this in the console at ${consoleUrl(app)}, or use an assistant that can ask you to confirm.`
  );
}

export interface AskedQuestion {
  nonce: string;
  keyId: string;
  tool: string;
  argsDigest: string;
  questionDigest: string;
  ttlMinutes: number;
}

/** Record that a question was put, so its note can be spent exactly once and expires by the platform clock. */
export async function recordQuestion(ctx: Ctx, q: AskedQuestion): Promise<void> {
  const now = ctx.now();
  await ctx.db
    .insertInto('agent_confirmations')
    .values({
      nonce: q.nonce,
      org_id: ctx.orgId,
      key_id: q.keyId,
      tool: q.tool,
      args_digest: q.argsDigest,
      question_digest: q.questionDigest,
      expires_at: new Date(now.getTime() + q.ttlMinutes * 60_000),
      created_at: now,
    })
    .execute();
}

export type NoteStanding = 'good' | 'unknown' | 'expired' | 'spent';

/**
 * Where a note stands, read from the row its number names. `unknown` covers a number this
 * organisation never issued, or one issued for another key, tool, arguments or question.
 */
export async function noteStanding(ctx: Ctx, state: ConfirmState, keyId: string): Promise<NoteStanding> {
  const row = await ctx.db
    .selectFrom('agent_confirmations')
    .select(['key_id', 'tool', 'args_digest', 'question_digest', 'expires_at', 'spent_at'])
    .where('nonce', '=', state.nonce)
    .executeTakeFirst();
  if (!row || row.key_id !== keyId || row.tool !== state.tool || row.args_digest !== state.args || row.question_digest !== state.asked) return 'unknown';
  if (row.spent_at) return 'spent';
  if (row.expires_at <= ctx.now()) return 'expired';
  return 'good';
}

/**
 * Spend a note's number. True exactly once. The update is the claim: of two callers racing on
 * one note, the second waits on the row and then finds it spent. Spent in the transaction that
 * makes the change, it is spent only if the change is.
 */
export async function spendNote(ctx: Ctx, nonce: string): Promise<boolean> {
  const now = ctx.now();
  const row = await ctx.db
    .updateTable('agent_confirmations')
    .set({ spent_at: now })
    .where('nonce', '=', nonce)
    .where('spent_at', 'is', null)
    .where('expires_at', '>', now)
    .returning('nonce')
    .executeTakeFirst();
  return !!row;
}
