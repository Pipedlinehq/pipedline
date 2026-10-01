import { getModule, getModuleDef, listModuleDefs } from '@ros/core';
import { atLeast, getConsole, inConsole } from '@/lib/console';
import { formSpec } from '@/lib/console-schema-form';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { ModuleSettingsForm } from '@/components/console/settings-form';
import { NotForYourRole } from '@/components/console/states';
import { Badge, Card, PageHeader } from '@/ui';
import { saveFeatureOptions, setFeatureEnabled } from './actions';

export const metadata = { title: 'Features · Restaurant OS' };

export default async function FeaturesPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Features" />;

  const modules = await inConsole(async (ctx) => {
    const defs = listModuleDefs().filter((d) => !d.spine);
    const out = [];
    for (const def of defs) {
      const state = await getModule(ctx, c.venue.id, def);
      const needs = def.dependsOn.map((k) => getModuleDef(k)).filter((d) => !d.spine);
      const needsOff = [];
      for (const d of needs) if (!(await getModule(ctx, c.venue.id, d)).enabled) needsOff.push(d.name);
      out.push({ key: def.key, name: def.name, description: def.description, enabled: state.enabled, needs: needs.map((d) => d.name), needsOff, fields: formSpec(def.configSchema, state.config) });
    }
    return out;
  });

  return (
    <>
      <PageHeader
        title="Features"
        description={`What is switched on at ${c.venue.name}, and how each feature behaves. Switching a feature off hides its screens and stops it for guests; its data is kept.`}
      />
      <div className="space-y-4">
        {modules.map((m) => (
          <Card
            key={m.key}
            title={m.name}
            description={m.description}
            actions={
              <div className="flex items-center gap-2" data-testid={`feature-${m.key}`}>
                <Badge tone={m.enabled ? 'good' : 'neutral'}>{m.enabled ? 'On' : 'Off'}</Badge>
                {m.enabled ? (
                  <ConfirmAction
                    trigger="Switch off"
                    title={`Switch off ${m.name}?`}
                    action={setFeatureEnabled}
                    hidden={{ module: m.key, enabled: 'false' }}
                    confirmLabel="Switch it off"
                    testId={`switch-off-${m.key}`}
                  >
                    <p>
                      {m.name} stops at <strong>{c.venue.name}</strong> straight away: guests can no longer use it, and its screens leave the console for everyone at this venue.
                    </p>
                    <p className="mt-2">Its data and settings are kept. Switching it back on brings them back.</p>
                  </ConfirmAction>
                ) : (
                  <InlineAction action={setFeatureEnabled} hidden={{ module: m.key, enabled: 'true' }} label="Switch on" pendingLabel="Switching on…" variant="primary" testId={`switch-on-${m.key}`} />
                )}
              </div>
            }
          >
            <div className="space-y-3">
              {m.needs.length ? (
                <p className="text-sm text-ink-2">
                  Needs {m.needs.join(', ')}.
                  {m.needsOff.length ? <span className="text-warn"> Switch on {m.needsOff.join(', ')} first.</span> : null}
                </p>
              ) : null}
              {m.fields.length ? (
                <details className="group">
                  <summary className="cursor-pointer text-sm font-medium text-accent">Options</summary>
                  <div className="mt-4">
                    <ModuleSettingsForm moduleKey={m.key} fields={m.fields} action={saveFeatureOptions} />
                  </div>
                </details>
              ) : (
                <p className="text-sm text-ink-3">No options to set.</p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
