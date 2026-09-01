import { expect, test } from 'bun:test';
import { nativeMcpServers } from '../src/agent/claude/native/mcp.ts';
import { runtimeCapabilities } from '../src/runtime/capabilities.ts';

/**
 * MCP servers of a session. What is NOT carried is the point: the configuration holds the URL, the
 * headers and any token the host put there, and a status projection is the wrong place for each.
 */

test('a server is reported without any of its configuration', () => {
  const [server] = nativeMcpServers([
    {
      name: 'notes',
      status: 'connected',
      scope: 'user',
      tools: [{}, {}],
      // A real report also carries `config` with the server URL and headers; it is not read.
      config: { url: 'https://example.test/mcp', headers: { authorization: 'secret' } },
    } as never,
  ]);
  expect(server).toEqual({
    name: 'notes',
    status: 'connected',
    scope: 'user',
    tools: 2,
    error: null,
  });
});

test('an unrecognised status becomes unknown rather than dropping the server', () => {
  // A server missing from the list reads as a server that does not exist, which is worse than a
  // status this build has not seen before.
  const [server] = nativeMcpServers([{ name: 'notes', status: 'reticulating' }]);
  expect(server?.status).toBe('unknown');
  expect(server?.name).toBe('notes');
});

test('a failed server keeps the sentence that explains it', () => {
  // Without it a failed server is undiagnosable, which is the whole reason a status exists.
  const [server] = nativeMcpServers([
    { name: 'notes', status: 'failed', error: 'connection refused' },
  ]);
  expect(server?.status).toBe('failed');
  expect(server?.error).toBe('connection refused');
  // No tool list means no count — zero would claim it contributes nothing, which is a different
  // statement from not having been told.
  expect(server?.tools).toBeNull();
});

test('MCP control is declared for the native mode alone', () => {
  expect(runtimeCapabilities({ agent: 'claude', runtime: 'native' }).mcpControl).toBe(true);
  expect(runtimeCapabilities({ agent: 'claude', runtime: 'tui' }).mcpControl).toBe(false);
});
