import { Badge } from '@/ui';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const STEP: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: 'neutral', label: 'Waiting' },
  running: { tone: 'accent', label: 'Running' },
  done: { tone: 'good', label: 'Done' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  blocked: { tone: 'warn', label: 'Blocked' },
  failed: { tone: 'bad', label: 'Failed' },
};

export function StepBadge({ status }: { status: string }) {
  const s = STEP[status] ?? { tone: 'neutral' as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const ONBOARDING: Record<string, { tone: Tone; label: string }> = {
  intake: { tone: 'neutral', label: 'Intake' },
  provisioning: { tone: 'accent', label: 'Provisioning' },
  review: { tone: 'warn', label: 'Ready for review' },
  stalled: { tone: 'bad', label: 'Stalled' },
  live: { tone: 'good', label: 'Live' },
};

export function OnboardingBadge({ status }: { status: string }) {
  const s = ONBOARDING[status] ?? { tone: 'neutral' as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const CHECK: Record<string, { tone: Tone; label: string }> = {
  pass: { tone: 'good', label: 'Pass' },
  fail: { tone: 'bad', label: 'Fail' },
  not_applicable: { tone: 'neutral', label: 'Not applicable' },
};

export function CheckBadge({ status }: { status: string }) {
  const s = CHECK[status] ?? { tone: 'neutral' as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function HealthBadge({ healthy }: { healthy: boolean }) {
  return healthy ? <Badge tone="good">Healthy</Badge> : <Badge tone="bad">Needs attention</Badge>;
}

export function hours(h: number | null | undefined): string {
  if (h === null || h === undefined) return '–';
  return h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} days`;
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' | 'good' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : ''}`}>{value}</p>
    </div>
  );
}
