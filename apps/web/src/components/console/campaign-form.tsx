'use client';

import { useActionState, useEffect, useState } from 'react';
import { Button, Field, FormMessage, Input, Select, SubmitButton, Textarea, type FormState } from '@/ui';

interface Copy {
  subject: string;
  body: string;
  smsBody: string;
}
type CopyState = ({ ok: true; message?: string; data?: Copy } | { ok: false; error: string }) | null;

/**
 * A campaign draft: who it goes to, on which channel, and the words. Saving a draft sends
 * nothing. "Check audience" and "Suggest copy" only read; the count is a number, never a list.
 */
export function CampaignForm({
  save,
  audience,
  suggest,
  segments,
  offers,
  initial,
  venueName,
}: {
  save: (prev: FormState, fd: FormData) => Promise<FormState>;
  audience: (prev: FormState, fd: FormData) => Promise<FormState>;
  suggest: (prev: CopyState, fd: FormData) => Promise<CopyState>;
  segments: Array<{ id: string; name: string; description: string | null }>;
  offers: Array<{ id: string; label: string }>;
  initial?: { id: string; name: string; channel: 'email' | 'sms'; segmentId: string | null; subject: string | null; body: string | null; offerId: string | null };
  venueName: string;
}) {
  const [saved, saveAction] = useActionState(save, null);
  const [counted, audienceAction] = useActionState(audience, null);
  const [copy, suggestAction] = useActionState(suggest, null);
  const [channel, setChannel] = useState<'email' | 'sms'>(initial?.channel ?? 'email');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [segmentId, setSegmentId] = useState(initial?.segmentId ?? '');
  const [offerId, setOfferId] = useState(initial?.offerId ?? '');
  const [name, setName] = useState(initial?.name ?? '');

  useEffect(() => {
    if (copy?.ok && copy.data) {
      if (channel === 'email') {
        setSubject(copy.data.subject);
        setBody(copy.data.body);
      } else setBody(copy.data.smsBody);
    }
    // Only when a new suggestion arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy]);

  return (
    <form action={saveAction} className="space-y-5">
      {initial ? <input type="hidden" name="campaignId" value={initial.id} /> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name" hint="For your own records. Guests do not see it (an SMS has no subject, an email shows its subject).">
          <Input name="name" required maxLength={120} value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="Channel" hint={initial ? 'The channel is fixed once a draft exists.' : `Sent from ${venueName}.`}>
          {initial ? <input type="hidden" name="channel" value={channel} /> : null}
          <Select name={initial ? undefined : 'channel'} value={channel} disabled={!!initial} onChange={(e) => setChannel(e.currentTarget.value === 'sms' ? 'sms' : 'email')}>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <Field label="Who it goes to" hint="A segment's guests whose home venue is this one, and only those who have agreed to hear from you on this channel.">
          <Select name="segmentId" required value={segmentId} onChange={(e) => setSegmentId(e.currentTarget.value)}>
            <option value="">Choose a segment…</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.description ? ` — ${s.description}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary" formAction={audienceAction} formNoValidate className="md:mb-6" data-testid="check-audience">
          Check audience
        </Button>
      </div>
      {counted ? (
        <div data-testid="audience-count">{counted.ok ? <FormMessage tone="info">{counted.message}</FormMessage> : <FormMessage tone="error">{counted.error}</FormMessage>}</div>
      ) : null}

      {offers.length ? (
        <Field label="Offer (optional)" hint="Each guest gets their own single-use code for this offer, added under your message.">
          <Select name="offerId" value={offerId} onChange={(e) => setOfferId(e.currentTarget.value)}>
            <option value="">No offer</option>
            {offers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <fieldset className="rounded-md border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink">Suggest the words (optional)</legend>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Field label="What is it about?" hint="The assistant is given this, the venue's tone of voice and the segment's name and size. It is never given a guest's name or contact details.">
            <Input name="brief" maxLength={600} placeholder="e.g. The winter menu starts Friday; the short rib is back" />
          </Field>
          <Button type="submit" variant="secondary" formAction={suggestAction} formNoValidate className="md:mb-6">
            Suggest copy
          </Button>
        </div>
        {copy ? <div className="mt-2">{copy.ok ? <FormMessage tone="info">{copy.message}</FormMessage> : <FormMessage tone="error">{copy.error}</FormMessage>}</div> : null}
      </fieldset>

      {channel === 'email' ? (
        <Field label="Subject">
          <Input name="subject" required maxLength={200} value={subject} onChange={(e) => setSubject(e.currentTarget.value)} />
        </Field>
      ) : null}
      <Field
        label="Message"
        hint={`Plain text. {{first_name}} is filled in for each guest.${channel === 'sms' ? ` ${body.length}/480 characters.` : ''} The unsubscribe line is added for you.`}
      >
        <Textarea name="body" required maxLength={channel === 'sms' ? 480 : 5000} value={body} onChange={(e) => setBody(e.currentTarget.value)} className="min-h-48" />
      </Field>

      {saved && !saved.ok ? <FormMessage tone="error">{saved.error}</FormMessage> : null}
      {saved?.ok && saved.message ? <FormMessage tone="success">{saved.message}</FormMessage> : null}
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving…">{initial ? 'Save draft' : 'Create draft'}</SubmitButton>
        <span className="text-xs text-ink-3">Saving a draft sends nothing.</span>
      </div>
    </form>
  );
}
