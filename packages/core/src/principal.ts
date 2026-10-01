/** Who is acting. Every tenant transaction carries exactly one. docs/THREAT_MODEL.md section 3. */

export type StaffRole = 'owner' | 'manager' | 'host' | 'kitchen' | 'front_of_house' | 'read_only';

export const ROLE_RANK: Record<StaffRole, number> = {
  read_only: 0,
  kitchen: 1,
  front_of_house: 1,
  host: 1,
  manager: 2,
  owner: 3,
};

export interface StaffPrincipal {
  kind: 'staff';
  staffId: string;
  userId: string;
  isOwner: boolean;
  /** venueId → role. An owner has every venue at 'owner'. */
  venueRoles: Record<string, StaffRole>;
}

export interface GuestPrincipal {
  kind: 'guest';
  customerId: string;
}

/** A visitor to a tenant's public site. Reads public content, may place an order. */
export interface AnonPrincipal {
  kind: 'anon';
  sessionId?: string;
}

export interface DevicePrincipal {
  kind: 'device';
  deviceId: string;
  venueId: string;
  purpose: 'kitchen' | 'counter';
}

/** A staff member's assistant. Never more than that staff member; reads unless they allowed changes. */
export interface AgentPrincipal {
  kind: 'agent';
  keyId: string;
  staff: StaffPrincipal;
  scopes: string[];
  /** null = every venue the staff member can see. */
  venueIds: string[] | null;
  canWrite: boolean;
  /**
   * Who the key is for: 'assistant' (a staff member's own, the default when absent) or
   * 'service:<plug key>' (a key an owner made for a connected service such as Criota).
   */
  audience?: string;
}

/** A background job acting for one org. */
export interface WorkerPrincipal {
  kind: 'worker';
  job: string;
}

/** Platform code (provisioning, host resolution, support access on the record). */
export interface PlatformPrincipal {
  kind: 'platform';
  adminUserId?: string;
  reason: string;
}

export type Principal =
  | StaffPrincipal
  | GuestPrincipal
  | AnonPrincipal
  | DevicePrincipal
  | AgentPrincipal
  | WorkerPrincipal
  | PlatformPrincipal;

export function actorOf(p: Principal): { kind: string; id: string | null } {
  switch (p.kind) {
    case 'staff':
      return { kind: 'staff', id: p.staffId };
    case 'guest':
      return { kind: 'guest', id: p.customerId };
    case 'anon':
      return { kind: 'anon', id: p.sessionId ?? null };
    case 'device':
      return { kind: 'device', id: p.deviceId };
    case 'agent':
      // A connected service's key is labelled as such on the audit log.
      return { kind: p.audience && p.audience !== 'assistant' ? 'service_key' : 'agent', id: p.keyId };
    case 'worker':
      return { kind: 'worker', id: p.job };
    case 'platform':
      return { kind: 'platform', id: p.adminUserId ?? null };
  }
}
