import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ConnectionHandle, RemoteMcpAuthError } from '@ros/core';
import { createHttpRemoteMcpAdapter, createSimCriotaMcp } from '@ros/adapters';

/**
 * The real remote-MCP adapter over a real socket: the simulated Criota server is put behind a
 * local HTTP listener and the adapter reaches it with the platform's own fetch, as it would
 * reach the real one. No database: this is the adapter and the protocol only.
 */
describe('hub: the remote MCP adapter over HTTP', () => {
  const sim = createSimCriotaMcp();
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const body = Buffer.concat(chunks);
      try {
        const answer = await sim.fetch(`http://${req.headers.host}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
        res.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
        res.end(Buffer.from(await answer.arrayBuffer()));
      } catch {
        // The simulator "lost the answer": drop the connection, as a network would.
        res.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const handle = (token: string): ConnectionHandle => ({ id: 'c1', orgId: 'o1', venueId: null, plugKey: 'criota', externalAccountId: 'default', scopes: ['read', 'write'], config: {}, credentials: { token } });

  it('lists the venue-side tools of Criota\'s catalogue with the connection\'s access key as the bearer token', async () => {
    const adapter = createHttpRemoteMcpAdapter({ key: 'criota', url, asksBeforeWriting: true });
    const tools = await adapter.listTools(handle(sim.issueKey('Over HTTP')));
    expect(tools.map((t) => t.name).sort()).toEqual([
      'account_status',
      'decide_application',
      'draft_campaign',
      'find_creators',
      'get_analytics',
      'list_applications',
      'list_campaigns',
      'list_reviews',
      'offer_licence',
      'publish_campaign',
      'review_content',
    ]);
    const decide = tools.find((t) => t.name === 'decide_application')!;
    expect(decide).toMatchObject({ title: 'Approve or decline an application', annotations: { readOnlyHint: false } });
    expect(decide.inputSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['application_id', 'decision']) });
    expect(tools.find((t) => t.name === 'list_campaigns')!.annotations).toMatchObject({ readOnlyHint: true });
    // A key the service gave less to is offered less: no changes.
    const readOnly = await adapter.listTools(handle(sim.issueKey('Over HTTP', { scopes: ['business:read'] })));
    expect(readOnly.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(readOnly).toHaveLength(7);
  });

  it('reads, previews a change by declining it, and makes it only on a yes to the question asked', async () => {
    const adapter = createHttpRemoteMcpAdapter({ key: 'criota', url, asksBeforeWriting: true });
    const conn = handle(sim.issueKey('Over HTTP'));
    const account = sim.account('Over HTTP');

    const read = await adapter.callTool(conn, 'get_analytics', {});
    expect(read).toMatchObject({ isError: false, asked: [], structured: { campaigns: { total: 2, active: 1 } } });

    const args = { application_id: '00000000-0000-4000-8000-000000000201', decision: 'approve' };
    // No answer given: every question is declined, which changes nothing there.
    const preview = await adapter.callTool(conn, 'decide_application', args);
    expect(preview.isError).toBe(true);
    expect(preview.asked).toEqual(['Approve @mia.eats for "Truffle week" and book their visit on 2026-10-03 at 18:00? They are told straight away.']);
    expect(account.applications[0]!.status).toBe('pending');

    const seen: string[] = [];
    const done = await adapter.callTool(conn, 'decide_application', args, {
      answer: (q) => {
        seen.push(q);
        return true;
      },
    });
    expect(seen).toEqual(preview.asked);
    expect(done).toMatchObject({ isError: false, structured: { done: 'approved' } });
    expect(account.applications[0]!.status).toBe('scheduled');
  });

  it('a refused key is an auth error, and a lost answer is a thrown error, never a result', async () => {
    const adapter = createHttpRemoteMcpAdapter({ key: 'criota', url, asksBeforeWriting: true, timeoutMs: 5000 });
    await expect(adapter.listTools(handle('criota_mcp_test_not_a_key'))).rejects.toBeInstanceOf(RemoteMcpAuthError);
    await expect(adapter.listTools({ ...handle('x'), credentials: {} })).rejects.toBeInstanceOf(RemoteMcpAuthError);

    const conn = handle(sim.issueKey('Lost answers'));
    const before = sim.account('Lost answers').campaigns.length;
    sim.dropNextAnswer();
    await expect(adapter.callTool(conn, 'publish_campaign', { title: 'Oyster hour', pay: 'contra', on_the_house: 80 }, { answer: () => true })).rejects.toThrow();
    // It was done there all the same, and only once: the adapter did not send it a second time.
    expect(sim.account('Lost answers').campaigns.length).toBe(before + 1);
    expect(sim.calls.filter((c) => c.account === 'Lost answers' && c.phase === 'confirmed')).toHaveLength(1);
  });
});
