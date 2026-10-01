import { z } from 'zod';
import { defineModule } from '@ros/core';

export const authModule = defineModule({
  key: 'console',
  name: 'Console access',
  description: 'Who can sign in: staff and their roles, guest sign-in, paired screens, sessions.',
  spine: true,
  dependsOn: ['tenancy', 'identity'],
  tables: ['users', 'platform_admins', 'staff', 'staff_venues', 'sessions', 'otp_codes', 'devices'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});

export const SESSION_TTL_DAYS = { staff: 14, guest: 30, platform: 1 } as const;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
