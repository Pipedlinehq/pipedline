import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@ros/core';
import { onboarding } from '@ros/modules';
import { app } from '@/lib/runtime';
import { platformActor } from '@/lib/ops-platform';
import { ActionForm, Card, Field, PageHeader, SubmitButton, Textarea } from '@/ui';
import { IntakeField } from '@/components/platform/intake-fields';
import { SECTION_FIELDS } from '@/components/platform/intake-forms';
import { StepBadge } from '@/components/platform/status';
import { saveSectionAction } from '../../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Intake · Platform' };

/** One section of the intake wizard: its fields, what is still missing, and the next and previous sections. */
export default async function IntakeSectionPage({ params }: { params: Promise<{ id: string; section: string }> }) {
  const { id, section } = await params;
  const def = onboarding.INTAKE_SECTIONS.find((s) => s.key === section);
  if (!def) notFound();
  let intake: onboarding.IntakeView;
  try {
    intake = await onboarding.getIntake(app(), await platformActor(), { onboardingId: id });
  } catch (e) {
    if (isAppError(e) && e.code === 'not_found') notFound();
    throw e;
  }
  const data = intake.data[def.key];
  const progress = intake.sections.find((s) => s.key === def.key)!;
  const fields = SECTION_FIELDS[def.key] ?? [];
  const index = onboarding.INTAKE_SECTIONS.indexOf(def);
  const prev = onboarding.INTAKE_SECTIONS[index - 1];
  const next = onboarding.INTAKE_SECTIONS[index + 1];

  return (
    <>
      <PageHeader
        title={def.label}
        description={
          <>
            <StepBadge status={progress.status === 'complete' ? 'done' : progress.status === 'in_progress' ? 'blocked' : 'pending'} /> {def.required ? 'Required before provisioning.' : 'Optional.'}{' '}
            {progress.missing.length ? `Still missing: ${progress.missing.join(', ')}.` : progress.status === 'complete' ? 'Complete.' : ''}
          </>
        }
        actions={
          <Link href={`/platform/onboarding/${id}`} className="text-sm text-accent underline">
            Back to the onboarding
          </Link>
        }
      />
      <nav aria-label="Sections" className="mb-6 flex flex-wrap gap-1">
        {intake.sections.map((s) => (
          <Link
            key={s.key}
            href={`/platform/onboarding/${id}/intake/${s.key}`}
            aria-current={s.key === def.key ? 'page' : undefined}
            className={`rounded-md border px-2 py-1 text-xs ${s.key === def.key ? 'border-ink bg-ink text-white' : 'border-line text-ink-2 hover:bg-sunken'}`}
          >
            {s.status === 'complete' ? '✓ ' : s.status === 'in_progress' ? '… ' : ''}
            {s.label}
          </Link>
        ))}
      </nav>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        {fields.length ? (
          <Card title="Answers">
            <ActionForm action={saveSectionAction} className="space-y-4">
              <input type="hidden" name="onboardingId" value={id} />
              <input type="hidden" name="section" value={def.key} />
              <input type="hidden" name="mode" value="fields" />
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((f) => (
                  <div key={f.name} className={f.kind === 'textarea' || f.kind === 'lines' || f.kind === 'hours' || f.kind === 'checkboxes' ? 'sm:col-span-2' : ''}>
                    <IntakeField def={f} data={data} />
                  </div>
                ))}
              </div>
              <SubmitButton pendingLabel="Saving…">Save section</SubmitButton>
            </ActionForm>
          </Card>
        ) : null}
        <Card title={fields.length ? 'Everything, as JSON' : 'Answers (JSON)'} description="For the nested parts: more venues, split shifts, the floor plan, the team. Checked against the same rules.">
          <ActionForm action={saveSectionAction} className="space-y-3">
            <input type="hidden" name="onboardingId" value={id} />
            <input type="hidden" name="section" value={def.key} />
            <input type="hidden" name="mode" value="json" />
            <Field label="JSON">
              <Textarea name="json" defaultValue={JSON.stringify(data ?? {}, null, 2)} className="min-h-80 font-mono text-xs" spellCheck={false} />
            </Field>
            <SubmitButton variant="secondary" pendingLabel="Saving…">
              Save JSON
            </SubmitButton>
          </ActionForm>
        </Card>
      </div>

      <div className="mt-6 flex justify-between">
        {prev ? (
          <Link className="text-sm text-accent underline" href={`/platform/onboarding/${id}/intake/${prev.key}`}>
            ← {prev.label}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link className="text-sm text-accent underline" href={`/platform/onboarding/${id}/intake/${next.key}`}>
            {next.label} →
          </Link>
        ) : null}
      </div>
    </>
  );
}
