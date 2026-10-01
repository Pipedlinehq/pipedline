'use client';

import { Button, EmptyState } from '@/ui';

export default function ConsoleError({ reset }: { error: Error; reset: () => void }) {
  return (
    <EmptyState title="Something went wrong on our side" action={<Button onClick={reset}>Try again</Button>}>
      Nothing was changed. If it keeps happening, tell us what you were doing.
    </EmptyState>
  );
}
