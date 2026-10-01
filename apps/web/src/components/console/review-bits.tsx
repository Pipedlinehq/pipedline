import { Badge, GuestText } from '@/ui';

const WORDS = ['', 'Poor', 'Fair', 'Okay', 'Good', 'Excellent'];

/** A rating as a number and a word. Never stars alone. */
export function ratingText(rating: number | null): string {
  return rating ? `${rating} of 5 · ${WORDS[rating] ?? ''}` : 'No rating';
}

export function sourceName(source: string): string {
  if (source === 'sim-reviews') return 'Simulated listing';
  if (source === 'google') return 'Google';
  return source.replace(/[-_]/g, ' ');
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
const REPLY: Record<string, { label: string; tone: Tone }> = {
  none: { label: 'No reply yet', tone: 'warn' },
  pending_approval: { label: 'Reply waiting', tone: 'accent' },
  posted: { label: 'Replied', tone: 'good' },
  failed: { label: 'Reply failed to post', tone: 'bad' },
};
const DRAFT: Record<string, { label: string; tone: Tone }> = {
  shadow: { label: 'Practice draft (not sent anywhere)', tone: 'neutral' },
  blocked: { label: 'Blocked by the reply rules', tone: 'bad' },
  pending: { label: 'Waiting for approval', tone: 'accent' },
  approved: { label: 'Approved, being posted', tone: 'accent' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  posted: { label: 'Posted', tone: 'good' },
  failed: { label: 'Failed to post', tone: 'bad' },
};
const AUTHOR: Record<string, string> = { agent: 'the review agent', assistant: "a staff member's assistant", staff: 'a staff member' };

export function ReplyStatus({ status }: { status: string }) {
  const s = REPLY[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function DraftStatus({ status }: { status: string }) {
  const s = DRAFT[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function draftAuthor(author: string): string {
  return AUTHOR[author] ?? author;
}

/** What a guest wrote on a public listing: quoted, as text, with who and how many stars. */
export function ReviewQuote({ rating, authorName, body }: { rating: number | null; authorName: string | null; body: string | null }) {
  return (
    <div>
      <p className="text-sm font-medium text-ink">
        {ratingText(rating)}
        <span className="font-normal text-ink-2"> · {authorName ? <span className="break-words">{authorName}</span> : 'A guest'}</span>
      </p>
      <p className="mt-1 text-sm">{body ? <GuestText>{body}</GuestText> : <span className="text-ink-3">Rating only, no words.</span>}</p>
    </div>
  );
}
