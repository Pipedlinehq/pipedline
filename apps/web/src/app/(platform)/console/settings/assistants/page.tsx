import { permanentRedirect } from 'next/navigation';

/** Assistant access moved to its own section on 2026-10-12 (docs/CONSOLE_IA.md). Old links still land. */
export default function MovedToAssistant() {
  permanentRedirect('/console/assistant');
}
