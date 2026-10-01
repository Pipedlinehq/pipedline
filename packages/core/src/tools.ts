import type { z } from 'zod';
import type { Ctx } from './app';
import type { StaffRole } from './principal';
import { keyedRegistry, register } from './registry';

/**
 * A tool an assistant may call. Declared by the module that owns the behaviour, served by the hub.
 * docs/modules/hub.md section 2.
 *
 * - The handler is the same service function the console calls, so module guards, role checks
 *   and row-level security apply without a second implementation.
 * - `output` is an allowlist: the hub parses the handler's return through it and only named
 *   fields leave. Declare it with z.object (unknown keys are stripped).
 * - A write tool implements `propose`, which changes nothing and returns the question a person
 *   must answer plus a `commit`. The hub calls `propose` on both halves of the two-call
 *   confirmation and only runs `commit` when the rebuilt question matches the one answered.
 */
export interface ToolContext {
  ctx: Ctx;
  /** Resolved from the tool's `venue` argument, or the key's only venue. Set when `venueScoped`. */
  venueId: string | null;
}

interface ToolBase<I, O> {
  name: string;
  module: string;
  title: string;
  description: string;
  /** e.g. 'sales:read'. A key must hold the scope for the tool to be offered. */
  scope: string;
  minRole?: StaffRole;
  /** When true the tool acts on one venue and the hub resolves which. */
  venueScoped?: boolean;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
}

export interface ReadTool<I, O> extends ToolBase<I, O> {
  effect: 'read';
  run(t: ToolContext, input: I): Promise<O>;
}

export interface Proposal<O> {
  /** Plain words, specific, stating exactly what will change. Shown to the person. */
  question: string;
  commit(): Promise<O>;
}

export interface WriteTool<I, O> extends ToolBase<I, O> {
  effect: 'write';
  /** True when the change moves money or sends to guests. Such a tool is never run autonomously. */
  sensitive?: boolean;
  propose(t: ToolContext, input: I): Promise<Proposal<O>>;
}

export type ToolDef<I = any, O = any> = ReadTool<I, O> | WriteTool<I, O>;

const tools = keyedRegistry<ToolDef>('tools');

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`Tool name ${def.name} must be snake_case`);
  register(tools, def.name, def as ToolDef, 'Tool');
  return def;
}

export function listTools(): ToolDef[] {
  return [...tools.values()];
}

export function getTool(name: string): ToolDef | undefined {
  return tools.get(name);
}
