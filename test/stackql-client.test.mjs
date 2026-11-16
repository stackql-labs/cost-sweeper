import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connectStackQL, safeStackQLFailure } from '../scripts/stackql-client.mjs';
import { readOnlyTools } from '../scripts/stackql-mcp.mjs';

function fakeSpawn(mode = 'read_only', toolResult, instructions) {
  let buffer = '';
  let child;
  const spawnProcess = () => {
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      setImmediate(() => {
        child.exitCode = 0;
        child.signalCode = signal;
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, signal);
      });
      return true;
    };
    child.stdin.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line);
        if (message.id === undefined) continue;
        let result;
        if (message.method === 'initialize') {
          result = { serverInfo: { name: 'fake-stackql', version: 'test' }, instructions };
        } else if (message.method === 'tools/list') {
          result = { tools: readOnlyTools.map((name) => ({
            name, inputSchema: { type: 'object', properties: {} },
          })) };
        } else if (message.method === 'tools/call' && message.params.name === 'server_info') {
          result = { content: [{ type: 'text', text: `mode: ${mode}\nis_read_only: ${mode === 'read_only'}` }] };
        } else {
          result = toolResult ?? { structuredContent: { rows: [{ name: message.params.name }] }, content: [] };
        }
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      }
    });
    return child;
  };
  return { spawnProcess, getChild: () => child };
}

test('StackQL client verifies read-only mode and exactly the configured tools', async () => {
  const instructions = 'Server guidance:\nDescribe the method and use its required WHERE parameters.\n';
  const fake = fakeSpawn('read_only', undefined, instructions);
  const client = await connectStackQL({
    command: 'stackql',
    args: [],
    options: {},
  }, { spawnProcess: fake.spawnProcess });
  assert.deepEqual([...client.tools.keys()].sort(), [...readOnlyTools].sort());
  assert.equal(client.instructions, instructions, 'initialize guidance is preserved verbatim');
  const result = await client.callTool('list_registry', { format: 'json' });
  assert.deepEqual(result.structuredContent.rows, [{ name: 'list_registry' }]);
  await assert.rejects(client.callTool('run_mutation_query', {}), /not allowlisted/);
  await client.close();
  assert.equal(fake.getChild().signalCode, 'SIGTERM');
});

test('malformed initialization guidance fails explicitly rather than being silently discarded', async () => {
  const fake = fakeSpawn('read_only', undefined, { unexpected: 'object' });
  await assert.rejects(connectStackQL({ command: 'stackql', args: [], options: {} }, {
    spawnProcess: fake.spawnProcess,
  }), /invalid initialization instructions/);
  assert.equal(fake.getChild().signalCode, 'SIGTERM');
});

test('successful empty StackQL rows remain empty, while tool failures are not fabricated emptiness', async () => {
  for (const result of [
    { structuredContent: { rows: [] }, content: [], isError: false },
    { content: [{ type: 'text', text: '{"rows":[]}' }] },
    { isError: true, content: [{ type: 'text', text: 'Transport failure' }] },
  ]) {
    const fake = fakeSpawn('read_only', result);
    const client = await connectStackQL({ command: 'stackql', args: [], options: {} }, { spawnProcess: fake.spawnProcess });
    try {
      if (result.isError) await assert.rejects(client.callTool('run_select_query', { sql: 'SELECT * FROM test' }), /call failed/);
      else assert.deepEqual(await client.callTool('run_select_query', { sql: 'SELECT * FROM test' }), result);
    } finally {
      await client.close();
    }
  }
});

test('StackQL client fails closed if the server does not confirm read-only mode', async () => {
  const fake = fakeSpawn('safe');
  await assert.rejects(connectStackQL({
    command: 'stackql',
    args: [],
    options: {},
  }, { spawnProcess: fake.spawnProcess }), /did not confirm read_only mode/);
  assert.equal(fake.getChild().signalCode, 'SIGTERM');
});

test('broken protocol and closed stdout stop calls with safe categorized connection errors', async () => {
  for (const reason of ['invalid_protocol', 'null', 'stream']) {
    const fake = fakeSpawn();
    const client = await connectStackQL({ command: 'stackql', args: [], options: {} }, { spawnProcess: fake.spawnProcess });
    try {
      if (reason === 'invalid_protocol') fake.getChild().stdout.write('private non-JSON backend payload\n');
      else if (reason === 'null') fake.getChild().stdout.write('null\n');
      else {
        fake.getChild().stdout.end();
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(client.failure);
      await assert.rejects(client.callTool('list_registry', {}), /protocol/);
      const message = safeStackQLFailure(client.failure);
      assert.match(message, reason === 'stream' ? /closed or failed/ : /invalid JSON/);
      assert.doesNotMatch(message, /private/);
    } finally {
      await client.close();
    }
  }
});

test('a timed-out MCP request stops the connection and rejects all outstanding and future requests', async () => {
  const fake = fakeSpawn();
  const client = await connectStackQL({ command: 'stackql', args: [], options: {} }, {
    spawnProcess: fake.spawnProcess, timeoutMs: 10,
  });
  fake.getChild().stdin.removeAllListeners('data');
  try {
    const results = await Promise.allSettled([client.request('tools/call'), client.request('tools/list')]);
    assert.ok(results.every((result) => result.status === 'rejected' && result.reason === client.failure));
    assert.match(safeStackQLFailure(client.failure), /request timeout/);
    await assert.rejects(client.callTool('list_registry', {}), /request timeout/);
    assert.equal(client.pending.size, 0);
  } finally {
    await client.close();
  }
});
