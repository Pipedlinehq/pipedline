import { Checkbox, Field, Input, Select, Textarea } from '@/ui';
import { DAY_OPTIONS, type FieldDef, getAt, hoursFrom } from './intake-forms';

/** One intake field as a labelled control, filled with what was saved. */
export function IntakeField({ def, data }: { def: FieldDef; data: unknown }) {
  const value = getAt(data, def.path);
  const text = value === undefined || value === null ? '' : String(value);
  switch (def.kind) {
    case 'checkbox':
      return <Checkbox name={def.name} label={def.label} hint={def.hint} defaultChecked={value === true || value === undefined} />;
    case 'checkboxes': {
      const chosen = new Set(Array.isArray(value) ? value.map(String) : []);
      return (
        <fieldset>
          <legend className="mb-1 text-sm font-medium">{def.label}</legend>
          <div className="flex flex-wrap gap-4">
            {def.options!.map((o) => (
              <Checkbox key={o.value} name={def.name} value={o.value} label={o.label} defaultChecked={chosen.has(o.value)} />
            ))}
          </div>
        </fieldset>
      );
    }
    case 'select':
      return (
        <Field label={def.label} hint={def.hint}>
          <Select name={def.name} defaultValue={text}>
            <option value="">Choose…</option>
            {def.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'textarea':
      return (
        <Field label={def.label} hint={def.hint}>
          <Textarea name={def.name} defaultValue={text} />
        </Field>
      );
    case 'lines':
      return (
        <Field label={def.label} hint={def.hint}>
          <Textarea name={def.name} defaultValue={Array.isArray(value) ? value.join('\n') : ''} />
        </Field>
      );
    case 'hours': {
      const h = hoursFrom(value);
      return (
        <fieldset className="rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium">{def.label}</legend>
          {def.hint ? <p className="mb-2 text-xs text-ink-3">{def.hint}</p> : null}
          <div className="mb-3 flex flex-wrap gap-3">
            {DAY_OPTIONS.map((d) => (
              <Checkbox key={d.value} name={`${def.name}_day`} value={d.value} label={d.label.slice(0, 3)} defaultChecked={h.days.includes(Number(d.value))} />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Opens">
              <Input name={`${def.name}_opens`} type="time" defaultValue={h.opensAt} />
            </Field>
            <Field label="Closes">
              <Input name={`${def.name}_closes`} type="time" defaultValue={h.closesAt} />
            </Field>
            <Field label="Service">
              <Input name={`${def.name}_service`} defaultValue={h.serviceType} />
            </Field>
          </div>
        </fieldset>
      );
    }
    default:
      return (
        <Field label={def.label} hint={def.hint}>
          <Input name={def.name} type={def.kind === 'email' ? 'email' : def.kind === 'number' ? 'number' : 'text'} defaultValue={text} placeholder={def.kind === 'color' ? '#14532D' : undefined} />
        </Field>
      );
  }
}
