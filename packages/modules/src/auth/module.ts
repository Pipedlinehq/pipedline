import { z } from 'zod';
import { defineModule } from '@ros/core';

export const authModule = defineModule({
  key: 'console',
  name: 'Team sign-in',
  description: 'Who can sign in: staff and their roles, guest sign-in, paired screens, sessions.',
  spine: true,
  dependsOn: ['tenancy', 'identity'],
  manifest: {
    name: 'Team sign-in',
    purpose: 'Who can sign in to the venue console and what each person may do: owner, manager, front of house, kitchen or read-only. Also paired kitchen screens and guests signing in to their own account.',
    category: 'setup',
    kind: 'module',
    needs: ['Nothing: the owner is signed in from the start and invites the team.'],
    reads: ['team members and their roles'],
    writes: ['team members and roles', 'sign-ins', 'paired screens'],
  },
  tables: ['users', 'platform_admins', 'staff', 'staff_venues', 'sessions', 'otp_codes', 'devices'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});

export const SESSION_TTL_DAYS = { staff: 14, guest: 30, platform: 1 } as const;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
