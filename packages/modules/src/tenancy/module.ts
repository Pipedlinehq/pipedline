import { z } from 'zod';
import { defineModule } from '@ros/core';

export const tenancyModule = defineModule({
  key: 'tenancy',
  name: 'Tenancy',
  description: 'Orgs, venues, domains, trading hours, module config and connections.',
  spine: true,
  dependsOn: [],
  tables: ['orgs', 'venues', 'domains', 'trading_hours', 'hour_exceptions', 'venue_modules', 'feature_flags', 'connections'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});
