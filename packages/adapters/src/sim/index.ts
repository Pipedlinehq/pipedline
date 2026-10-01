import { type AdapterRegistry, type LlmPort, createAdapterRegistry } from '@ros/core';
import { createSimLlm, createSimStorage, type SimLlm, type SimStorage } from './llm';
import { createSimMessageAdapter, type SimMessageAdapter } from './message';
import { createSimCriotaMcp, type SimCriotaMcp } from './criota-mcp';
import { createHttpRemoteMcpAdapter } from '../mcp/http';
import { createSimHosting, createSimSendingDomains, type SimHosting, type SimSendingDomains } from './hosting';
import { createSimPaymentAdapter, type SimPaymentAdapter } from './payment';
import { createSimPosAdapter, type SimPosAdapter } from './pos';
import { SIM_COURIER_A, SIM_COURIER_B, createSimCourierAdapter, type SimCourierAdapter } from './courier';
import { createSimReviewsAdapter, type SimReviewsAdapter } from './reviews';
import { createSimEspAdapter, type SimEspAdapter } from './esp';
import { createSimAdsAdapter, type SimAdsAdapter } from './ads';
import { createSimSignIn, simSignInPayment, simSignInPos, type SimSignIn } from './oauth';

export * from './signing';
export * from './message';
export * from './llm';
export * from './criota-mcp';
export * from './hosting';
export * from './payment';
export * from './pos';
export * from './courier';
export * from './reviews';
export * from './esp';
export * from './ads';
export * from './oauth';

/** Handles on every simulated provider, so a test or the development console can inspect and steer them. */
export interface Sim {
  email: SimMessageAdapter;
  sms: SimMessageAdapter;
  llm: SimLlm;
  storage: SimStorage;
  /** A simulated Criota MCP server, reached through the real remote-MCP adapter (plug `criota-sim`). */
  criota: SimCriotaMcp;
  hosting: SimHosting;
  sendingDomains: SimSendingDomains;
  payment: SimPaymentAdapter;
  /** A simulated point of sale (plug `sim-pos`): ring up sales, refund them, emit its webhooks. */
  pos: SimPosAdapter;
  /** Two simulated courier services (plugs `sim-courier-a`, `sim-courier-b`): the preferred one and its failover. */
  courierA: SimCourierAdapter;
  courierB: SimCourierAdapter;
  /** A simulated review listing (plug `sim-reviews`). */
  reviews: SimReviewsAdapter;
  /** A simulated connected email platform (plug `sim-esp`). */
  esp: SimEspAdapter;
  /** A simulated ad platform's conversions endpoint (plug `sim-ads`). */
  ads: SimAdsAdapter;
  /**
   * A simulated sign-in provider standing in for one sign-in POS plug, or null. Only present
   * when asked for (`posSignIn`): see sim/oauth.ts for when the runtime does.
   */
  posSignIn: SimSignIn | null;
}

export const SIM_WEBHOOK_SECRET = 'sim-webhook-secret';

/**
 * A registry where every port is answered by a simulator. Used by tests, local development and
 * the fixtures. Each module's simulators are added here as the module is built.
 */
export function createSimAdapters(
  opts: {
    clock?: () => Date;
    llm?: LlmPort;
    /** Stand a simulated sign-in provider in for this sign-in POS plug (sim/oauth.ts). Off unless given. */
    posSignIn?: { plugKey: string; baseUrl: string };
  } = {},
): { registry: AdapterRegistry; sim: Sim } {
  const llm = createSimLlm();
  const storage = createSimStorage();
  // A real model may stand in for the simulated one (runtime: ANTHROPIC_API_KEY); `sim.llm` is then unused.
  const registry = createAdapterRegistry({ llm: opts.llm ?? llm, storage });
  const email = createSimMessageAdapter({ key: 'sim-email', channels: ['email'], clock: opts.clock });
  const sms = createSimMessageAdapter({ key: 'sim-sms', channels: ['sms'], costCents: 8, clock: opts.clock });
  registry.register('message', email);
  registry.register('message', sms);
  const hosting = createSimHosting();
  const sendingDomains = createSimSendingDomains(email.key);
  registry.register('hosting', hosting);
  registry.register('sending_domain', sendingDomains);
  // A payment that names a pushed POS order pays it at the POS, as Square does.
  const payment = createSimPaymentAdapter({
    clock: opts.clock,
    onCaptured: (c) => {
      if (c.posOrderRef) pos.settleOnlinePayment(c.posOrderRef, { amountCents: c.amountCents, tipCents: c.tipCents, paymentRef: c.externalRef });
    },
  });
  registry.register('payment', payment);
  const pos = createSimPosAdapter({ clock: opts.clock });
  registry.register('pos', pos);
  const courierA = createSimCourierAdapter({ key: SIM_COURIER_A, feeCents: 900, clock: opts.clock });
  const courierB = createSimCourierAdapter({ key: SIM_COURIER_B, feeCents: 1100, clock: opts.clock });
  registry.register('courier', courierA);
  registry.register('courier', courierB);
  const criota = createSimCriotaMcp();
  registry.register('remote_mcp', createHttpRemoteMcpAdapter({ key: 'criota-sim', url: criota.url, asksBeforeWriting: true, fetch: criota.fetch }));
  const reviews = createSimReviewsAdapter({ clock: opts.clock });
  registry.register('reviews', reviews);
  const esp = createSimEspAdapter({ clock: opts.clock });
  registry.register('esp', esp);
  const ads = createSimAdsAdapter();
  registry.register('ads', ads);
  let posSignIn: SimSignIn | null = null;
  if (opts.posSignIn) {
    posSignIn = createSimSignIn({ key: opts.posSignIn.plugKey, baseUrl: opts.posSignIn.baseUrl, clock: opts.clock });
    registry.register('oauth', posSignIn);
    registry.register('pos', simSignInPos(pos, posSignIn));
    registry.register('payment', simSignInPayment(payment, posSignIn.key));
  }
  return { registry, sim: { email, sms, llm, storage, hosting, sendingDomains,payment, criota, pos, reviews, esp, ads, courierA, courierB, posSignIn } };
}
