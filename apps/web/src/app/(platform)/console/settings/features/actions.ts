'use server';

import { revalidatePath } from 'next/cache';
import { getModule, listModuleDefs, setModule, type ModuleDef } from '@ros/core';
import { runAction } from '@/lib/actions';
import { getConsole, inConsole } from '@/lib/console';
import { bustSite } from '@/lib/site-revalidate';
import { act, text } from '@/lib/console-actions';
import { formSpec, readForm } from '@/lib/console-schema-form';
import type { FormState } from '@/ui/client';

/** Only a real, toggleable module can be named; the key is not trusted beyond that. */
function toggleable(key: string): ModuleDef<any> | null {
  return listModuleDefs().find((d) => d.key === key && !d.spine) ?? null;
}

export async function setFeatureEnabled(_prev: FormState, fd: FormData): Promise<FormState> {
  const def = toggleable(text(fd, 'module'));
  if (!def) return { ok: false, error: 'That feature does not exist.' };
  const enabled = text(fd, 'enabled') === 'true';
  return act((ctx, c) => setModule(ctx, def, { venueId: c.venue.id, enabled }), {
    success: (s) => `${def.name} is now ${s.enabled ? 'on' : 'off'} at this venue.`,
    // Switching the website (or a feature a page section depends on) changes what the site shows.
    bustsSite: true,
  });
}

export async function saveFeatureOptions(_prev: FormState, fd: FormData): Promise<FormState> {
  const def = toggleable(text(fd, 'module'));
  if (!def) return { ok: false, error: 'That feature does not exist.' };
  const r = await runAction(() =>
    inConsole(async (ctx, c) => {
      const current = await getModule(ctx, c.venue.id, def);
      const { config, errors } = readForm(formSpec(def.configSchema, current.config), fd);
      if (errors.length) return { errors };
      await setModule(ctx, def, { venueId: c.venue.id, config });
      return { errors: [] as string[] };
    }),
  );
  if (!r.ok) {
    const issues = Array.isArray(r.issues) ? (r.issues as Array<{ path?: unknown[]; message?: string }>) : [];
    const detail = issues.map((i) => `${(i.path ?? []).join(' › ') || 'value'}: ${i.message}`).join(' ');
    return { ok: false, error: detail ? `${r.error} ${detail}` : r.error };
  }
  if (r.data.errors.length) return { ok: false, error: r.data.errors.join(' ') };
  revalidatePath('/console', 'layout');
  bustSite((await getConsole()).session.orgId);
  return { ok: true, message: `${def.name} options saved.` };
}
