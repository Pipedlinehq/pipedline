import { z } from 'zod';
import { type Ctx, keyedRegistry, register } from '@ros/core';

/**
 * A message template. The platform ships a working default for every key; an org may override
 * the subject and body. Bodies are plain text with {{variables}}; nothing in a template or a
 * variable is ever treated as markup (docs/THREAT_MODEL.md section 6).
 */
export interface TemplateDef<V = Record<string, unknown>> {
  key: string;
  channel: 'email' | 'sms';
  kind: 'transactional' | 'marketing';
  description: string;
  subject?: string;
  body: string;
  variables: z.ZodType<V>;
}

const registry = keyedRegistry<TemplateDef<any>>('comms.templates');
const regKey = (key: string, channel: string) => `${key}:${channel}`;

export function defineTemplate<V>(def: TemplateDef<V>): TemplateDef<V> {
  const k = regKey(def.key, def.channel);
  if (def.channel === 'email' && !def.subject) throw new Error(`Email template ${def.key} needs a subject`);
  return register(registry, k, def, 'Template');
}

export function getTemplateDef(key: string, channel: 'email' | 'sms'): TemplateDef<any> | undefined {
  return registry.get(regKey(key, channel));
}

export function listTemplateDefs(): TemplateDef<any>[] {
  return [...registry.values()];
}

const VAR = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function lookup(vars: Record<string, unknown>, path: string): string {
  let v: unknown = vars;
  for (const part of path.split('.')) {
    if (v === null || typeof v !== 'object') return '';
    v = (v as Record<string, unknown>)[part];
  }
  if (v === null || v === undefined) return '';
  return String(v);
}

export function fill(template: string, vars: Record<string, unknown>): string {
  return template.replace(VAR, (_, path: string) => lookup(vars, path));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/** Plain text → safe HTML paragraphs, with bare URLs turned into links. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      const escaped = escapeHtml(para).replace(/\n/g, '<br>');
      return `<p style="margin:0 0 16px">${escaped.replace(URL_RE, (u) => `<a href="${u}">${u}</a>`)}</p>`;
    })
    .join('\n');
}

export interface Rendered {
  subject: string | null;
  text: string;
  html: string | null;
}

export interface RenderFrame {
  orgName: string;
  /** Appended to marketing messages. */
  unsubscribeUrl?: string | null;
  senderAddressLine?: string | null;
  accentColour?: string;
}

/** Render a template for one recipient. The org's override wins over the platform default. */
export async function renderTemplate(
  ctx: Ctx,
  key: string,
  channel: 'email' | 'sms',
  variables: Record<string, unknown>,
  frame: RenderFrame,
): Promise<{ rendered: Rendered; kind: 'transactional' | 'marketing' }> {
  const def = getTemplateDef(key, channel);
  if (!def) throw new Error(`No ${channel} template is defined for ${key}`);
  const vars = def.variables.parse(variables) as Record<string, unknown>;

  const override = await ctx.db
    .selectFrom('templates')
    .select(['subject', 'body'])
    .where('org_id', '=', ctx.orgId)
    .where('template_key', '=', key)
    .where('channel', '=', channel)
    .where('is_active', '=', true)
    .executeTakeFirst();

  const all = { ...vars, org_name: frame.orgName };
  const subject = channel === 'email' ? fill(override?.subject ?? def.subject ?? '', all) : null;
  let text = fill(override?.body ?? def.body, all);

  if (channel === 'sms') {
    if (def.kind === 'marketing') text += `\nReply STOP to opt out.`;
    return { rendered: { subject: null, text, html: null }, kind: def.kind };
  }

  const footer: string[] = [];
  if (def.kind === 'marketing') {
    footer.push(`Sent by ${frame.orgName}${frame.senderAddressLine ? `, ${frame.senderAddressLine}` : ''}.`);
    if (frame.unsubscribeUrl) footer.push(`Unsubscribe: ${frame.unsubscribeUrl}`);
  }
  if (footer.length) text += `\n\n--\n${footer.join('\n')}`;

  const accent = /^#[0-9a-fA-F]{6}$/.test(frame.accentColour ?? '') ? frame.accentColour : '#1a1614';
  const bodyHtml = textToHtml(fill(override?.body ?? def.body, all));
  const footerHtml = footer.length
    ? `<p style="margin:24px 0 0;font-size:12px;color:#6b615a">${escapeHtml(footer[0]!)}${
        frame.unsubscribeUrl ? ` <a href="${escapeHtml(frame.unsubscribeUrl)}">Unsubscribe</a>` : ''
      }</p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5;color:#1a1614;background:#ffffff">
<div style="max-width:560px;margin:0 auto">
<p style="margin:0 0 24px;font-weight:700;font-size:18px;color:${accent}">${escapeHtml(frame.orgName)}</p>
${bodyHtml}
${footerHtml}
</div></body></html>`;
  return { rendered: { subject, text, html }, kind: def.kind };
}

export const orgTemplateInput = z.object({
  templateKey: z.string(),
  channel: z.enum(['email', 'sms']),
  subject: z.string().max(200).nullish(),
  body: z.string().min(1).max(10_000),
});

export const genericNoticeEmail = defineTemplate({
  key: 'generic.notice',
  channel: 'email',
  kind: 'transactional',
  description: 'A plain notice with a heading and a body. For one-off operational messages.',
  subject: '{{subject}}',
  body: '{{body}}',
  variables: z.object({ subject: z.string().max(200), body: z.string().max(5000) }),
});
