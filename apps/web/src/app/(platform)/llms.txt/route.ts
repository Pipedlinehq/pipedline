import { tenancy } from '@ros/modules';
import { route } from '@/lib/http';
import { app } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * The plugin catalogue as plain text for assistants (docs/CONSOLE_IA.md section 6): what
 * Pipedline is, the two MCP endpoints, each plugin in a paragraph, and the tools. Generated from
 * the same module definitions as /plugins.json, never written by hand. Public, cacheable, no
 * venue data. Platform host only.
 */
export const GET = route(async () => tenancy.llmsTxtResponse(tenancy.pluginCatalogue(app())));
