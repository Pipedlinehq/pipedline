import { addDays, localDate, setModule } from '@ros/core';
import { bookings } from '@ros/modules';
import type { ModuleSeeder } from '../index';

const WORKER = { kind: 'worker' as const, job: 'fixtures' };

/**
 * Table bookings at every fixture venue that seats guests (Bondi is pickup only and keeps it
 * off). The diner sets its own services (lunch with a last booking at 14:00, dinner with a last
 * booking at 20:30); the group's venues follow their opening hours. A few phone bookings are
 * made through the module's own function, so the audit entries and events exist as they would
 * for a real venue. They carry no email or phone, so seeding sends nothing.
 */
const seeder: ModuleSeeder = {
  module: 'bookings',
  async seed(app, fixture) {
    // Every fixture venue is in Sydney; "tomorrow" is the venue's own calendar day.
    const tomorrow = addDays(localDate(app.clock(), 'Australia/Sydney'), 1);

    await app.tenant(fixture.diner.orgId, WORKER, async (ctx) => {
      const venueId = fixture.diner.venueId;
      await setModule(ctx, bookings.bookingsModule, {
        venueId,
        enabled: true,
        config: {
          service_periods: [
            { name: 'Lunch', days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'], starts_at: '12:00', ends_at: '15:00', last_booking_at: '14:00' },
            { name: 'Dinner', days: ['tue', 'wed', 'thu', 'fri', 'sat'], starts_at: '17:30', ends_at: '22:00', last_booking_at: '20:30' },
          ],
          max_covers_per_slot: 12,
          max_covers_per_service: 50,
          booking_note: 'Groups over 8, please call us.',
        },
      });
      await bookings.addBooking(ctx, { venueId, date: tomorrow, time: '19:00', partySize: 4, name: 'Jordan Lee', note: 'Anniversary' });
      await bookings.addBooking(ctx, { venueId, date: tomorrow, time: '12:30', partySize: 2, name: 'Sam Ortiz' });
    });

    await app.tenant(fixture.group.orgId, WORKER, async (ctx) => {
      for (const key of ['cbd', 'newtown'] as const) {
        const venueId = fixture.group.venues[key]!.id;
        await setModule(ctx, bookings.bookingsModule, { venueId, enabled: true });
        await bookings.addBooking(ctx, { venueId, date: tomorrow, time: '18:30', partySize: 6, name: 'Casey Group' });
      }
    });
  },
};

export default seeder;
