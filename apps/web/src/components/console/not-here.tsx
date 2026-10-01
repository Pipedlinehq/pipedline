import { EmptyState, LinkButton } from '@/ui';

/**
 * An id that is not visible to this person (another org, a venue they have no role at, a
 * mistyped link). Said in place, the same words as the console's not-found page, without
 * saying whether the thing exists anywhere else.
 */
export function NotHere({ back, label }: { back: string; label: string }) {
  return (
    <EmptyState title="That is not here" action={<LinkButton href={back}>{label}</LinkButton>}>
      It may have been removed, belong to another venue, or be part of a feature that is switched off.
    </EmptyState>
  );
}
