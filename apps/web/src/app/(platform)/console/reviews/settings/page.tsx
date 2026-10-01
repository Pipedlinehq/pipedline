import Link from 'next/link';
import { getModule } from '@ros/core';
import { hub, reviews } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { formSpec } from '@/lib/console-schema-form';
import { ModuleSettingsForm } from '@/components/console/settings-form';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card } from '@/ui';
import { saveReviewSettings } from '../actions';
import { ReviewsFrame } from '../shared';

export const metadata = { title: 'Reply settings · Reviews · Pipedline' };

const MODE: Record<string, { label: string; means: string }> = {
  off: { label: 'Off', means: 'The review agent drafts nothing. Replies are written by people.' },
  shadow: { label: 'Practice', means: 'The agent drafts replies so you can judge them, shown in the inbox as practice drafts. Nothing is queued for approval and nothing is posted.' },
  supervised: { label: 'Supervised', means: 'The agent drafts a reply to each new review and queues it in Approvals. A manager approves each one before it is posted.' },
  autonomous: { label: 'Supervised', means: 'The agent drafts replies and queues each one for a manager. It can never post without a person.' },
};

/** Plain words for this module's options. */
const LABELS: Record<string, { label: string; hint?: string }> = {
  'cfg.reply_max_chars': { label: 'Longest reply (characters)', hint: '100 to 4,000.' },
  'cfg.draft_for_ratings': { label: 'Ratings the agent drafts replies for', hint: 'Numbers from 1 to 5, separated by commas.' },
  'cfg.collect_insights': { label: 'Also collect the daily searches, clicks, calls and direction requests the listing reports' },
  'cfg.forbidden_phrases': { label: 'Words or phrases no drafted reply may use', hint: 'Separated by commas. Added to the built-in rules.' },
};

/** How replies are drafted at this venue: limits, which ratings, banned phrases, and how far the agent may go. */
export default async function ReviewSettingsPage() {
  const c = await getConsole();
  if (!(await moduleOn('reviews'))) return <ReviewsFrame c={c} current="/console/reviews/settings">{null}</ReviewsFrame>;
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Reply settings" />;
  const [state, mode] = await Promise.all([read((ctx) => getModule(ctx, c.venue.id, reviews.reviewsModule)), read((ctx) => hub.agentMode(ctx, c.venue.id, reviews.reviewReplier))]);
  const m = mode.ok ? (MODE[mode.data] ?? MODE.off!) : null;

  return (
    <ReviewsFrame c={c} current="/console/reviews/settings" description={`How replies to ${c.venue.name}'s reviews are drafted. Whatever is set here, a reply is posted only after a person approves it.`}>
      <div className="space-y-6">
        <Card title="The review agent" description="Drafts replies for a person to approve. It never posts by itself.">
          {m ? (
            <div className="space-y-2 text-sm" data-testid="agent-mode">
              <p className="flex items-center gap-2">
                <span className="text-ink-2">At this venue it is</span>
                <Badge tone={mode.ok && mode.data !== 'off' ? 'accent' : 'neutral'}>{m.label}</Badge>
              </p>
              <p className="text-ink-2">{m.means}</p>
              <p className="text-ink-2">
                Every machine-drafted reply is checked by fixed rules before anyone sees it for approval: no refunds or offers, no admissions of fault, no contact details, none of the phrases you ban below, and not longer than your limit. A draft that fails is kept as blocked and never queued.
              </p>
              <p>
                <Link href="/console/settings/assistants" className="text-accent hover:underline">
                  Change how far the agent may go in Settings → Assistant access
                </Link>
              </p>
            </div>
          ) : mode.ok ? null : (
            <ReadError message={mode.error} />
          )}
        </Card>
        <Card title="Reply rules for this venue">
          {state.ok ? <ModuleSettingsForm moduleKey="reviews" fields={formSpec(reviews.reviewsModule.configSchema, state.data.config).map((f) => (LABELS[f.path] ? { ...f, ...LABELS[f.path] } : f))} action={saveReviewSettings} /> : <ReadError message={state.error} />}
        </Card>
      </div>
    </ReviewsFrame>
  );
}
