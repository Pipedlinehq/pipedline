import type { OpenSupport } from '@/lib/ops-platform';

/** Shown on every platform page while this admin has support access open inside a tenant. */
export function SupportBanner({ open, close }: { open: OpenSupport[]; close: (form: FormData) => Promise<void> }) {
  if (!open.length) return null;
  return (
    <div role="alert" data-testid="support-banner" className="border-b-4 border-bad bg-bad-soft">
      {open.map((s) => (
        <div key={s.accessId} className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-3 text-sm text-bad">
          <span className="rounded bg-bad px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">Support access open</span>
          <span>
            You are acting inside <strong>{s.orgName}</strong>. Reason on their record: “{s.reason}”. Everything you do there is in their audit log.
          </span>
          <form action={close} className="ml-auto">
            <input type="hidden" name="accessId" value={s.accessId} />
            <button type="submit" className="h-8 rounded-md bg-bad px-3 text-sm font-medium text-white hover:bg-bad/85">
              Close access
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
