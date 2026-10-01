'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError } from '@ros/core';
import { onboarding } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { app } from '@/lib/runtime';
import { platformActor } from '@/lib/ops-platform';
import { sectionFromForm } from '@/components/platform/intake-forms';
import type { FormState } from '@/ui/client';

/** Server actions for onboarding. Every one runs as the signed-in platform admin; the service checks that again. */

const done = (message: string): FormState => ({ ok: true, message });

export async function startOnboardingAction(_p: FormState, form: FormData): Promise<FormState> {
  const tradingName = String(form.get('tradingName') ?? '');
  const contactEmail = String(form.get('contactEmail') ?? '').trim() || undefined;
  const contactFirstName = String(form.get('contactFirstName') ?? '').trim() || undefined;
  const r = await runAction(async () => onboarding.startOnboarding(app(), await platformActor(), { tradingName, contactEmail, contactFirstName }));
  if (!r.ok) return { ok: false, error: r.error };
  redirect(`/platform/onboarding/${r.data.onboardingId}`);
}

export async function saveSectionAction(_p: FormState, form: FormData): Promise<FormState> {
  const onboardingId = String(form.get('onboardingId') ?? '');
  const section = String(form.get('section') ?? '') as onboarding.IntakeSectionKey;
  const mode = String(form.get('mode') ?? 'fields');
  const r = await runAction(async () => {
    const actor = await platformActor();
    let data: unknown;
    if (mode === 'json') {
      try {
        data = JSON.parse(String(form.get('json') ?? '{}'));
      } catch {
        throw new AppError('invalid', 'That is not valid JSON.');
      }
    } else {
      const current = await onboarding.getIntake(app(), actor, { onboardingId });
      data = sectionFromForm(section, form, current.data[section]);
    }
    return onboarding.saveIntakeSection(app(), actor, { onboardingId, section, data });
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/platform/onboarding/${onboardingId}`, 'layout');
  const s = r.data.sections.find((x) => x.key === section)!;
  return done(s.status === 'complete' ? 'Saved. This section is complete.' : `Saved. Still missing: ${s.missing.join(', ') || 'nothing'}.`);
}

export async function startProvisioningAction(_p: FormState, form: FormData): Promise<FormState> {
  const onboardingId = String(form.get('onboardingId') ?? '');
  const r = await runAction(async () => onboarding.startProvisioning(app(), await platformActor(), { onboardingId }));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/platform/onboarding/${onboardingId}`);
  return done('Provisioning has started. The steps below fill in as the worker runs them.');
}

export async function retryStepAction(_p: FormState, form: FormData): Promise<FormState> {
  const onboardingId = String(form.get('onboardingId') ?? '');
  const step = String(form.get('step') ?? '');
  const r = await runAction(async () => onboarding.retryProvisioningStep(app(), await platformActor(), { onboardingId, step }));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/platform/onboarding/${onboardingId}`);
  return done('Queued to run again.');
}

export async function manualTouchAction(_p: FormState, form: FormData): Promise<FormState> {
  const onboardingId = String(form.get('onboardingId') ?? '');
  const minutes = Number(form.get('minutes') ?? 0);
  const note = String(form.get('note') ?? '');
  const r = await runAction(async () => onboarding.recordManualTouch(app(), await platformActor(), { onboardingId, minutes, note }));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/platform/onboarding/${onboardingId}`);
  return done(`Recorded. ${r.data.manualTouchMinutes} hands-on minutes in total.`);
}

export async function goLiveAction(_p: FormState, form: FormData): Promise<FormState> {
  const onboardingId = String(form.get('onboardingId') ?? '');
  const r = await runAction(async () => onboarding.goLive(app(), await platformActor(), { onboardingId }));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath('/platform', 'layout');
  return done(`Live. ${r.data.timeToLiveHours} hours from sold to live, ${r.data.manualTouchMinutes} hands-on minutes.`);
}
