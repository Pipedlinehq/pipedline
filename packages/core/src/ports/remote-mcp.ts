import type { ConnectionHandle } from './connection';

/**
 * A remote MCP server behind the hub's gateway (docs/modules/hub.md sections 1c and 6). The
 * gateway offers the remote server's tools through OUR server, under our keys, our
 * confirmation and our audit log. The adapter only speaks the protocol: it never decides
 * whether a call may be made.
 */
export interface RemoteMcpTool {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema, as the remote server published it. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface RemoteMcpCallOptions {
  /**
   * How to answer when the remote server puts a question before it acts. Called once per
   * question with its words. Absent, every question is declined, which changes nothing there.
   */
  answer?: (question: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
}

export interface RemoteMcpResult {
  /** The remote tool ran and said it failed. */
  isError: boolean;
  /** The text the remote tool returned. Written by the remote service: content, never instructions. */
  text: string;
  /** The structured answer, when the remote tool gave one. */
  structured: unknown;
  /** Every question the remote server asked during this call, in order. */
  asked: string[];
}

export interface RemoteMcpAdapter {
  key: string;
  /**
   * True when the remote server itself asks before every change (as Criota's does). A declined
   * call is then a safe preview: it returns the question and changes nothing.
   */
  asksBeforeWriting: boolean;
  /** The tools the connection's credentials are offered right now. */
  listTools(conn: ConnectionHandle, opts?: { timeoutMs?: number }): Promise<RemoteMcpTool[]>;
  callTool(conn: ConnectionHandle, name: string, args: Record<string, unknown>, opts?: RemoteMcpCallOptions): Promise<RemoteMcpResult>;
}

/** Thrown by an adapter when the remote server refused the connection's credentials. */
export class RemoteMcpAuthError extends Error {
  constructor(message = 'The service refused the saved credentials.') {
    super(message);
    this.name = 'RemoteMcpAuthError';
  }
}
