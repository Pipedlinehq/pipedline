'use server';

import { invalid } from '@ros/core';
import { comms, tenancy } from '@ros/modules';
import { act, text } from '@/lib/console-actions';
import { formSpec, readForm } from '@/lib/console-schema-form';
import { app } from '@/lib/runtime';
import type { FormState } from '@/ui/client';

const PATH = '/console/settings/privacy';

export async function saveCommsSettings(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(
    async (ctx) => {
      const current = await tenancy.getOrgSettings(ctx, 'comms', comms.commsSettings, comms.defaultCommsSettings);
      const { config, errors } = readForm(formSpec(comms.commsSettings, current), fd);
      if (errors.length) throw invalid(errors.join(' '));
      return tenancy.setOrgSettings(ctx, 'comms', comms.commsSettings, { ...current, ...config } as comms.CommsSettings);
    },
    { success: 'Message settings saved.', revalidate: PATH },
  );
}

export async function addIdentity(_prev: FormState, fd: FormData): Promise<FormState> {
  const channel = text(fd, 'channel') === 'sms' ? 'sms' : 'email';
  const cfg = app().config.comms;
  return act(
    (ctx) =>
      comms.addSendingIdentity(
        ctx,
        channel === 'email'
          ? { channel, domain: text(fd, 'domain'), fromLocalPart: text(fd, 'fromLocalPart') || 'hello', fromName: text(fd, 'fromName') }
          : { channel, smsSenderId: text(fd, 'smsSenderId') },
        { key: channel === 'email' ? cfg.emailAdapter : cfg.smsAdapter },
      ),
    { success: 'Added. It sends nothing until the provider confirms it (DNS records for a domain, registration for a sender ID).', revalidate: PATH },
  );
}
