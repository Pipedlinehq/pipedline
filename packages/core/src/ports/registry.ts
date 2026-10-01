import type { PosAdapter } from './pos';
import type { PaymentAdapter } from './payment';
import type { CourierAdapter } from './courier';
import type { EspAdapter, MessageAdapter } from './messaging';
import type { AdsAdapter, ReviewsAdapter } from './marketing';
import type { LlmPort, StoragePort } from './llm';
import type { HostingPort, SendingDomainPort } from './hosting';
import type { RemoteMcpAdapter } from './remote-mcp';
import type { OAuthPort } from './oauth';

/** Extend by declaration merging when a module introduces a new kind of adapter. */
export interface AdapterKinds {
  pos: PosAdapter;
  payment: PaymentAdapter;
  courier: CourierAdapter;
  message: MessageAdapter;
  esp: EspAdapter;
  ads: AdsAdapter;
  reviews: ReviewsAdapter;
  hosting: HostingPort;
  sending_domain: SendingDomainPort;
  remote_mcp: RemoteMcpAdapter;
  oauth: OAuthPort;
}

export interface AdapterRegistry {
  get<K extends keyof AdapterKinds>(kind: K, key: string): AdapterKinds[K];
  has<K extends keyof AdapterKinds>(kind: K, key: string): boolean;
  register<K extends keyof AdapterKinds>(kind: K, adapter: AdapterKinds[K]): void;
  keys<K extends keyof AdapterKinds>(kind: K): string[];
  llm: LlmPort;
  storage: StoragePort;
}

export function createAdapterRegistry(base: { llm: LlmPort; storage: StoragePort }): AdapterRegistry {
  const byKind = new Map<string, Map<string, { key: string }>>();
  return {
    llm: base.llm,
    storage: base.storage,
    get(kind, key) {
      const adapter = byKind.get(kind)?.get(key);
      if (!adapter) throw new Error(`No ${String(kind)} adapter registered for "${key}"`);
      return adapter as never;
    },
    has(kind, key) {
      return byKind.get(kind)?.has(key) ?? false;
    },
    register(kind, adapter) {
      let m = byKind.get(kind);
      if (!m) byKind.set(kind, (m = new Map()));
      m.set((adapter as { key: string }).key, adapter as { key: string });
    },
    keys(kind) {
      return [...(byKind.get(kind)?.keys() ?? [])];
    },
  };
}
