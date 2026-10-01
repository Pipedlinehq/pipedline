'use client';

import { useFormStatus } from 'react-dom';
import { Button } from '@/ui';

/** Two answers, one form: the button pressed says which. Neither can be pressed twice. */
export function AnswerButtons({ assistant }: { assistant: string }) {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <Button type="submit" name="answer" value="deny" variant="secondary" disabled={pending}>
        Do not connect
      </Button>
      <Button type="submit" name="answer" value="allow" disabled={pending} aria-busy={pending}>
        {pending ? 'Working…' : `Connect ${assistant.length > 40 ? 'this assistant' : assistant}`}
      </Button>
    </div>
  );
}
