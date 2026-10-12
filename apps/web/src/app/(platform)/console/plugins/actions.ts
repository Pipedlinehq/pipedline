'use server';

import { revalidatePath } from 'next/cache';
import { isAppError } from '@ros/core';
import { tenancy } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { getConsole, inConsole } from '@/lib/console';
import { act, text } from '@/lib/console-actions';
import { formSpecFromJson, readForm, type JS } from '@/lib/console-schema-form';
import { bustSite } from '@/lib/site-revalidate';
import type { FormState } from '@/ui/client';

/**
 * Switching a plugin on or off and saving its settings, through the same functions the
 * assistant's `plugin_enable` / `plugin_configure` / `plugin_disable` use (tenancy/plugins.ts):
 * the settings are checked against the plugin's own schema and the refusal says which setting is
 * wrong and why. The venue is the console's selected one, never a form field.
 */
const PATHS = ['/console', '/console/plugins', '/console/channels', '/console/settings/features'];

export async function setPluginEnabled(_prev: FormState, fd: FormData): Promise<FormState> {
  const plugin = text(fd, 'module');
  const enabled = text(fd, 'enabled') === 'true';
  const name = text(fd, 'name') || plugin;
  return act((ctx, c) => (enabled ? tenancy.enablePlugin(ctx, { venueId: c.venue.id, plugin }) : tenancy.disablePlugin(ctx, { venueId: c.venue.id, plugin })), {
    success: (s) => `${name} is now ${s.on ? 'on' : 'off'} at this venue.`,
    revalidate: PATHS,
    // Switching the website (or a feature a page section depends on) changes what the site shows.
    bustsSite: true,
  });
}

/** Save a plugin's settings from the generated form. The form is rebuilt from the catalogue so only real settings are read. */
export async function savePluginOptions(_prev: FormState, fd: FormData): Promise<FormState> {
  const plugin = text(fd, 'module');
  const r = await runAction(() =>
    inConsole(async (ctx, c) => {
      const view = (await tenancy.pluginCatalogueForVenue(ctx, c.venue.id)).plugins.find((p) => p.key === plugin);
      if (!view || !view.config_schema) return { outcome: 'missing' as const, name: plugin, errors: [] as string[] };
      const { config, errors } = readForm(formSpecFromJson(view.config_schema as JS, view.config ?? {}), fd);
      if (errors.length) return { outcome: 'form' as const, name: view.name, errors };
      try {
        await tenancy.configurePlugin(ctx, { venueId: c.venue.id, plugin, config });
      } catch (e) {
        // Saving a form nobody changed is not a mistake.
        if (isAppError(e) && e.code === 'invalid' && e.message.startsWith('Nothing would change')) return { outcome: 'unchanged' as const, name: view.name, errors: [] as string[] };
        throw e;
      }
      return { outcome: 'saved' as const, name: view.name, errors: [] as string[] };
    }),
  );
  if (!r.ok) return { ok: false, error: r.error };
  if (r.data.outcome === 'missing') return { ok: false, error: 'That plugin does not exist.' };
  if (r.data.outcome === 'form') return { ok: false, error: r.data.errors.join(' ') };
  if (r.data.outcome === 'unchanged') return { ok: true, message: `Nothing to save: ${r.data.name} already has these settings.` };
  for (const p of PATHS) revalidatePath(p, p === '/console' ? 'layout' : 'page');
  bustSite((await getConsole()).session.orgId);
  return { ok: true, message: `${r.data.name} settings saved.` };
}
