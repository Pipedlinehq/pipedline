import { type AdapterRegistry, type AppConfig, AppError, type Clock, type LlmPort, type StoragePort } from '@ros/core';
import {
  RESEND_KEY,
  TWILIO_KEY,
  createDoorDashDriveAdapter,
  createHttpRemoteMcpAdapter,
  createKlaviyoAdapter,
  createMetaCapiAdapter,
  createResendMessageAdapter,
  createResendSendingDomains,
  createSquareAdapter,
  createSquareOAuth,
  createTwilioMessageAdapter,
  createUberDirectAdapter,
  createVercelHosting,
} from '@ros/adapters';
import type { ProviderConfig } from './env';

/**
 * The live composition root: each real adapter is registered only when its provider is
 * configured (packages/runtime/src/env.ts). Used for ROS_ADAPTERS=live on an empty registry and
 * for ROS_ADAPTERS=mixed on top of the simulators.
 *
 * None of these adapters has been run against its provider: see docs/GOING_LIVE.md and
 * scripts/smoke-live.ts for how to prove each one.
 */
export interface LiveWiring {
  /** `kind:key` of every real adapter registered. */
  registered: string[];
  /** What the comms config should point at, for the channels that are configured. */
  comms: { emailAdapter?: string; smsAdapter?: string; webhookSecrets: Record<string, string> };
}

/** The public webhook URLs providers are told to call, derived from the platform host. */
export function webhookUrls(config: Pick<AppConfig, 'scheme' | 'platformHost'>) {
  const base = `${config.scheme}://${config.platformHost}/webhooks`;
  return {
    resend: `${base}/messages/${RESEND_KEY}`,
    twilio: `${base}/messages/${TWILIO_KEY}`,
    square: `${base}/pos/square`,
    uberDirect: `${base}/couriers/uber-direct`,
    doordashDrive: `${base}/couriers/doordash-drive`,
  };
}

export function registerLiveAdapters(registry: AdapterRegistry, providers: ProviderConfig, opts: { clock: Clock; config: Pick<AppConfig, 'scheme' | 'platformHost'> }): LiveWiring {
  const registered: string[] = [];
  const comms: LiveWiring['comms'] = { webhookSecrets: {} };
  const urls = webhookUrls(opts.config);
  const add: AdapterRegistry['register'] = (kind, adapter) => {
    registry.register(kind, adapter);
    registered.push(`${kind}:${(adapter as { key: string }).key}`);
  };

  if (providers.resend) {
    const o = { apiKey: providers.resend.RESEND_API_KEY, clock: opts.clock };
    add('message', createResendMessageAdapter(o));
    // Same key as the message adapter: onboarding looks the sending-domain port up by it.
    add('sending_domain', createResendSendingDomains(o));
    comms.emailAdapter = RESEND_KEY;
    comms.webhookSecrets[RESEND_KEY] = providers.resend.RESEND_WEBHOOK_SECRET;
  }

  if (providers.twilio) {
    const url = providers.twilio.TWILIO_WEBHOOK_URL ?? urls.twilio;
    add(
      'message',
      createTwilioMessageAdapter({
        accountSid: providers.twilio.TWILIO_ACCOUNT_SID,
        authToken: providers.twilio.TWILIO_AUTH_TOKEN,
        messagingServiceSid: providers.twilio.TWILIO_MESSAGING_SERVICE_SID,
        statusCallbackUrl: url,
        webhookUrl: url,
        clock: opts.clock,
      }),
    );
    comms.smsAdapter = TWILIO_KEY;
    // Twilio signs its webhooks with the account's auth token: there is no separate secret.
    comms.webhookSecrets[TWILIO_KEY] = providers.twilio.TWILIO_AUTH_TOKEN;
  }

  if (providers.vercel) {
    add('hosting', createVercelHosting({ token: providers.vercel.VERCEL_API_TOKEN, projectId: providers.vercel.VERCEL_PROJECT_ID, teamId: providers.vercel.VERCEL_TEAM_ID }));
  }

  if (providers.square) {
    // One object answers both ports; a venue's own tokens arrive per connection.
    const square = createSquareAdapter();
    add('pos', square);
    add('payment', square);
    add(
      'oauth',
      createSquareOAuth({
        applicationId: providers.square.SQUARE_APPLICATION_ID,
        applicationSecret: providers.square.SQUARE_APPLICATION_SECRET,
        environment: providers.square.SQUARE_ENVIRONMENT,
        webhookSignatureKey: providers.square.SQUARE_WEBHOOK_SIGNATURE_KEY,
        webhookUrl: providers.square.SQUARE_WEBHOOK_URL ?? urls.square,
      }),
    );
  }

  // These four hold no platform credentials: each venue's connection carries its own. The
  // switch only says "this deployment offers the provider".
  if (providers.uberDirect) add('courier', createUberDirectAdapter({ clock: opts.clock }));
  if (providers.doordashDrive) add('courier', createDoorDashDriveAdapter({ clock: opts.clock }));
  if (providers.klaviyo) add('esp', createKlaviyoAdapter());
  if (providers.metaCapi) add('ads', createMetaCapiAdapter());

  if (providers.criota) {
    // Criota asks before every change (docs/modules/hub.md section 6), so a declined call is a safe preview.
    add('remote_mcp', createHttpRemoteMcpAdapter({ key: 'criota', url: providers.criota.CRIOTA_MCP_URL, asksBeforeWriting: true }));
  }

  return { registered, comms };
}

/** Stands in for the model when ANTHROPIC_API_KEY is not set: features that need it say so; nothing else is affected. */
export function unconfiguredLlm(): LlmPort {
  return {
    async generate() {
      throw new AppError('unavailable', 'The assistant model is not set up on this platform yet.');
    },
  };
}

/**
 * There is no real file-storage adapter yet (docs/GOING_LIVE.md, "Not available live").
 * Uploads are refused with a clear message rather than kept in memory and lost on restart.
 */
export function unconfiguredStorage(): StoragePort {
  const refuse = async (): Promise<never> => {
    throw new AppError('unavailable', 'File storage is not set up on this platform yet.');
  };
  return { put: refuse, remove: refuse };
}
