'use server';

import { revokeConnection } from '@ros/core';
import type { FormState } from '@/ui/client';
import { act, text } from '@/lib/console-actions';

/** Disconnect a service from its plugin page: the same revoke Connected services uses. */
export async function disconnectFromDetail(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'connectionId');
  const key = text(fd, 'key');
  return act((ctx) => revokeConnection(ctx, id), { success: 'Disconnected. Its stored credentials were destroyed and its tools are withdrawn.', revalidate: [`/console/plugins/${key}`, '/console/plugins', '/console/settings/connections'] });
}
