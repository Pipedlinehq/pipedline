import { z } from 'zod';
import { defineModule } from '@ros/core';

export const tenancyModule = defineModule({
  key: 'tenancy',
  name: 'Venue details',
  description: 'Orgs, venues, domains, trading hours, module config and connections.',
  spine: true,
  dependsOn: [],
  manifest: {
    name: 'Venue details',
    purpose: 'The venue itself: its name, address, phone, opening hours and web address, which plugins are on, and which outside services are connected.',
    category: 'setup',
    kind: 'module',
    needs: ['Nothing: every venue has it from the start.'],
    reads: ['venue details', 'opening hours', 'web addresses'],
    writes: ['venue details', 'opening hours and closed days', 'web addresses', 'which plugins are on and their settings', 'connected services'],
  },
  tables: ['orgs', 'venues', 'domains', 'trading_hours', 'hour_exceptions', 'venue_modules', 'feature_flags', 'connections'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});
