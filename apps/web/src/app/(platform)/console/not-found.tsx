import { EmptyState, LinkButton } from '@/ui';

export default function ConsoleNotFound() {
  return (
    <EmptyState title="That is not here" action={<LinkButton href="/console">Back to the overview</LinkButton>}>
      It may have been removed, belong to another venue, or be part of a feature that is switched off.
    </EmptyState>
  );
}
