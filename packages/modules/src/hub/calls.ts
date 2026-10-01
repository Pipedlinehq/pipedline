import { z } from 'zod';
import { type App, type Ctx, isAppError, rateLimit } from '@ros/core';
import { type AskedQuestion, type ConfirmState, type NoteStanding, argsDigest, cannotAskMessage, consoleUrl, newNonce, noteStanding, questionDigest, readAnswer, recordQuestion, spendNote } from './confirm';
import { type ResolvedAgentKey, asCaller } from './keys';
import { type OfferedTool, narrowTo, resolveVenue } from './offer';

/**
 * One tool call, start to finish (docs/modules/hub.md section 2). A call:
 *   - is counted against the key's and the organisation's allowance;
 *   - has its arguments checked against the tool's own shape;
 *   - runs inside the tenant transaction of the key's organisation, as the key's principal, so
 *     row-level security, role checks and module guards apply exactly as they do for the console;
 *   - answers only with what the tool's `output` shape names: a field nobody named cannot leave;
 *   - is written to `agent_calls`: which key, which tool, what happened. Never the arguments'
 *     values and never the result.
 *
 * A WRITE IS TWO CALLS (./confirm.ts). The first changes nothing: `propose` runs in a
 * transaction that is rolled back, whatever it did, and the call answers with the question. The
 * second carries the person's answer and the signed note from the first. The change is made only
 * when the note verifies, names this tool and these arguments, has not been spent or expired,
 * the answer is yes, AND the question built again from what is true now reads exactly as the one
 * they answered. The note is spent in the same transaction that makes the change.
 */

/** How a call went, as `agent_calls.outcome` records it. */
export type Recorded =
  | 'answered' // a read answered
  | 'asked' // a change put its question; nothing changed
  | 'confirmed' // the person said yes and the change was made
  | 'declined' // the person did not say yes
  | 'cannot_ask' // the assistant cannot put a question to its person
  | 'stale' // the answer came with no note, or a note for something else
  | 'expired' // the note was past its time
  | 'spent' // the note had been used already
  | 'changed' // the question reads differently now than when it was answered
  | 'unsure' // a change was sent and its outcome is not known
  | 'unconfirmed' // a connected service acted without asking first
  | 'capped' // a hosted agent had used the organisation's actions for the day
  | 'invalid' // the arguments did not fit
  | 'rate_limited'
  | 'refused' // the venue system, or the connected service, said no
  | 'failed'; // something broke

export type ToolOutcome = { ok: true; output: Record<string, unknown> } | { ok: false; message: string; ask?: { question: string; requestState: string } };

/**
 * Where a question's single-use note is kept between the two halves of a change. An assistant's
 * is a row in `agent_confirmations`, tied to its access key. A hosted agent has no key: its
 * runner keeps the note for the length of one run (hub/runner.ts), and a question that must wait
 * for a person waits in the approvals queue instead.
 */
export interface NoteStore {
  record(ctx: Ctx, q: AskedQuestion): Promise<void>;
  standing(ctx: Ctx, state: ConfirmState, keyId: string): Promise<NoteStanding>;
  /** True exactly once. */
  spend(ctx: Ctx, nonce: string): Promise<boolean>;
}

const KEY_NOTES: NoteStore = { record: recordQuestion, standing: noteStanding, spend: spendNote };

/** The half of a call that is about asking the person. Absent for a read. */
export interface Asking {
  /** Whether the assistant can put a question to its person. */
  canAsk: boolean;
  /** What the assistant sent back from the person, on the second call. */
  inputResponses?: Record<string, unknown>;
  /** The note from the first call, its signature already verified by the time it is here. */
  state?: ConfirmState;
  /** Seal the note that travels with the question. */
  mint(state: ConfirmState): Promise<string>;
  /** Where the note is kept. Default: `agent_confirmations`, by access key. */
  notes?: NoteStore;
}

export const SAID = {
  stale: 'Nothing was changed. The details are not the ones you were asked about; ask again.',
  declined: 'Nothing was changed: you did not confirm it.',
  changed: 'Nothing was changed. Something about this changed after you were asked; ask again to see it as it is now.',
  spent: 'Nothing was changed. That confirmation has already been used; ask again to do it again.',
  expired: 'Nothing was changed. That confirmation has expired; ask again.',
  unavailable: 'The venue system could not answer just now. Try again in a moment.',
  tooMany: 'That is as many requests as this access key may make in a minute. Try again shortly.',
} as const;

/** Said when a change was sent and its answer was lost. "Try again" would be the wrong advice: it may already be done. */
export function unsureMessage(app: App, where?: string): string {
  return where
    ? `It could not be confirmed whether ${where} did that. Check ${where} before trying again.`
    : `It could not be confirmed whether that was done. Check the console at ${consoleUrl(app)} before trying again.`;
}

export function invalidMessage(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5).map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
  return `That was not valid. ${issues.join('; ')}`;
}

/** Per key, so one assistant cannot spend another's allowance; per organisation, so ten keys cannot either. */
export async function throttle(app: App, caller: ResolvedAgentKey): Promise<void> {
  await rateLimit(app, `hub:key:${caller.keyId}`, { limit: caller.limits.calls_per_key_per_minute, windowSeconds: 60 }, SAID.tooMany);
  await rateLimit(app, `hub:org:${caller.orgId}`, { limit: caller.limits.calls_per_org_per_minute, windowSeconds: 60 }, SAID.tooMany);
}

/** What the person is told when something said no. An AppError's message was written for a person; nothing else is passed on. */
export function sayNo(app: App, e: unknown, tool: string): { message: string; recorded: Recorded } {
  if (isAppError(e)) return { message: e.message, recorded: e.code === 'rate_limited' ? 'rate_limited' : 'refused' };
  if (e instanceof z.ZodError) return { message: invalidMessage(e), recorded: 'invalid' };
  app.log.error('hub tool failed', { tool, error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'unknown' });
  return { message: SAID.unavailable, recorded: 'failed' };
}

export interface CallRecord {
  /** 'os' for the venue's own tools; the plug's key for a connected service's. */
  plug?: string;
  tool: string;
  effect: 'read' | 'write';
  outcome: Recorded;
  /** From performance.now() at the start of the call. */
  startedAt: number;
}

/** How agent_calls.actor_kind labels who made a call. */
export function actorKind(caller: ResolvedAgentKey): 'hosted_agent' | 'service_key' | 'oauth_assistant' | 'agent_key' {
  if (caller.hosted) return 'hosted_agent';
  if (caller.audience && caller.audience !== 'assistant') return 'service_key';
  return caller.kind === 'oauth' ? 'oauth_assistant' : 'agent_key';
}

/** One row per call: key, tool, plug, effect, outcome. No arguments, no results. */
export async function recordCall(app: App, caller: ResolvedAgentKey, call: CallRecord, extra?: (ctx: Ctx) => Promise<void>): Promise<void> {
  try {
    await asCaller(app, caller, async (ctx) => {
      await ctx.db
        .insertInto('agent_calls')
        .values({
          org_id: ctx.orgId,
          // A hosted agent's call is its own, not a key's.
          key_id: caller.hosted ? null : caller.keyId,
          actor_kind: actorKind(caller),
          hosted_agent_key: caller.hosted?.agentKey ?? null,
          agent_run_id: caller.hosted?.runId ?? null,
          plug_key: call.plug ?? 'os',
          tool: call.tool,
          effect: call.effect,
          outcome: call.outcome,
          duration_ms: Math.max(0, Math.round(performance.now() - call.startedAt)),
          occurred_at: ctx.now(),
        })
        .execute();
      if (extra) await extra(ctx);
    });
  } catch (e) {
    // The call has already happened; losing its record must not change what the person is told.
    app.log.error('hub: could not record a tool call', { tool: call.tool, outcome: call.outcome, error: (e as Error).message?.slice(0, 300) });
  }
}

/** Carries a value out of a transaction that must not commit. */
class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('rolled back on purpose');
  }
}

/** Run `fn` in a tenant transaction and roll it back, whatever it did. For reading what a change WOULD do. */
async function changingNothing<T>(app: App, caller: ResolvedAgentKey, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  try {
    await asCaller(app, caller, async (ctx) => {
      throw new Rollback(await fn(ctx));
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error('unreachable');
}

type Settled = { recorded: Recorded; outcome: ToolOutcome };
const no = (recorded: Recorded, message: string): Settled => ({ recorded, outcome: { ok: false, message } });

/** Run one of the venue's own tools. Exported so it can be tested without a transport. */
export async function runTool(app: App, caller: ResolvedAgentKey, offered: OfferedTool, rawArgs: unknown, asking?: Asking): Promise<ToolOutcome> {
  const { tool } = offered;
  const startedAt = performance.now();
  // The tool runs with the key held to the venues where the hub lets this tool be used.
  const exec = narrowTo(caller, offered.venues);
  // Set once the transaction's own work is finished and only its commit remains.
  let committing = false;
  let settled: Settled;

  const shaped = (built: unknown): { ok: true; output: Record<string, unknown> } | null => {
    // The declared shape is the last word on what leaves.
    const checked = tool.output.safeParse(built);
    if (checked.success) return { ok: true, output: checked.data as Record<string, unknown> };
    app.log.error('hub tool output did not match its shape', { tool: tool.name, issues: checked.error.issues.slice(0, 5).map((i) => i.path.join('.')) });
    return null;
  };

  try {
    await throttle(app, caller);
    const parsed = offered.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      settled = no('invalid', invalidMessage(parsed.error));
    } else {
      const args = parsed.data as Record<string, unknown>;
      const venue = resolveVenue(caller, offered, args.venue);
      const { venue: _chosen, ...own } = args;
      const input: unknown = tool.input.parse(offered.takesVenue ? own : args);
      const venueId = venue?.id ?? null;

      if (tool.effect === 'read') {
        const built = await asCaller(app, exec, (ctx) => tool.run({ ctx, venueId }, input));
        const out = shaped(built);
        settled = out ? { recorded: 'answered', outcome: out } : no('failed', SAID.unavailable);
      } else if (!asking || !asking.canAsk) {
        // Nobody to ask: nothing is changed, and nothing is even read.
        settled = no('cannot_ask', cannotAskMessage(app));
      } else {
        const answer = readAnswer(asking.inputResponses);
        const digest = argsDigest(tool.name, args);
        const state = asking.state;
        const notes = asking.notes ?? KEY_NOTES;

        if (answer === 'none') {
          // The first call. Say what would happen; change nothing.
          const question = await changingNothing(app, exec, async (ctx) => (await tool.propose({ ctx, venueId }, input)).question);
          const note: ConfirmState = { tool: tool.name, args: digest, asked: questionDigest(question), nonce: newNonce() };
          const ttlMinutes = venue ? venue.config.write_confirmation_ttl_minutes : Math.min(...caller.venues.map((v) => v.config.write_confirmation_ttl_minutes));
          await asCaller(app, caller, (ctx) =>
            notes.record(ctx, { nonce: note.nonce, keyId: caller.keyId, tool: note.tool, argsDigest: note.args, questionDigest: note.asked, ttlMinutes }),
          );
          const requestState = await asking.mint(note);
          settled = { recorded: 'asked', outcome: { ok: false, message: question, ask: { question, requestState } } };
        } else if (!state || state.tool !== tool.name || state.args !== digest) {
          // An answer with no note, or a note for something else: the person was not asked about THIS.
          settled = no('stale', SAID.stale);
        } else {
          try {
            settled = await asCaller(app, exec, async (ctx): Promise<Settled> => {
              const standing = await notes.standing(ctx, state, caller.keyId);
              if (standing === 'unknown') return no('stale', SAID.stale);
              if (standing === 'expired') return no('expired', SAID.expired);
              if (standing === 'spent') return no('spent', SAID.spent);
              if (answer === 'no') {
                // A question that was declined cannot be answered again with a yes.
                await notes.spend(ctx, state.nonce);
                return no('declined', SAID.declined);
              }
              // A yes. Read it all again: what they agreed to must still be true.
              const proposal = await tool.propose({ ctx, venueId }, input);
              if (questionDigest(proposal.question) !== state.asked) throw new Rollback(no('changed', SAID.changed));
              if (!(await notes.spend(ctx, state.nonce))) throw new Rollback(no('spent', SAID.spent));
              const out = shaped(await proposal.commit());
              // A change whose answer cannot be shown is not kept: the person is told nothing was changed, and that is true.
              if (!out) throw new Rollback(no('failed', `Nothing was changed. ${SAID.unavailable}`));
              committing = true;
              return { recorded: 'confirmed', outcome: out };
            });
          } catch (e) {
            if (e instanceof Rollback) settled = e.value as Settled;
            else if (committing) {
              // Everything ran and the commit itself did not come back: it may or may not have landed.
              app.log.error('hub write: the outcome is not known', { tool: tool.name, error: (e as Error).message?.slice(0, 300) });
              settled = no('unsure', unsureMessage(app));
            } else {
              // Thrown inside the transaction, which was therefore rolled back.
              const said = sayNo(app, e, tool.name);
              settled = no(said.recorded, said.recorded === 'failed' ? `Nothing was changed. ${said.message}` : `Nothing was changed: ${said.message}`);
            }
          }
        }
      }
    }
  } catch (e) {
    const said = sayNo(app, e, tool.name);
    settled = no(said.recorded, said.message);
  }

  await recordCall(app, caller, { tool: tool.name, effect: tool.effect, outcome: settled.recorded, startedAt });
  return settled.outcome;
}

