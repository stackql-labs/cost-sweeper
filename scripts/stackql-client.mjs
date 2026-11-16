import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import { readOnlyTools } from './stackql-mcp.mjs';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const EXPECTED_TOOLS = new Set(readOnlyTools);

const connectionErrors = {
  stream: 'StackQL MCP protocol stream closed or failed.',
  startup: 'Could not start StackQL MCP. Check that StackQL is on PATH.',
  exited: 'StackQL MCP exited before collection completed.',
  input: 'StackQL MCP input stream closed unexpectedly.',
  oversized: 'StackQL MCP returned a protocol message larger than the 32 MiB limit. Narrow inventory projections and scopes.',
  invalid_protocol: 'StackQL MCP returned invalid JSON protocol data.',
  timeout: 'StackQL MCP exceeded the request timeout. Collection on this connection has stopped.',
  write: 'Could not send a request or initialization notification to StackQL MCP.',
};

export class StackQLConnectionError extends Error {
  constructor(reason) {
    super(connectionErrors[reason] ?? 'StackQL MCP transport failed.');
    this.name = 'StackQLConnectionError';
  }
}

export function safeStackQLFailure(error) {
  return error instanceof StackQLConnectionError ? error.message
    : 'The shared cost-sweeper-stackql MCP connection failed during collection.';
}

export class StackQLClient {
  constructor(server, { spawnProcess = spawn, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.child = spawnProcess(server.command, server.args, {
      ...server.options,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.failure = null;
    this.closed = false;
    this.tools = new Map();
    this.instructions = '';
    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.onLine(line));
    this.reader.on('error', () => this.fail(new StackQLConnectionError('stream')));
    this.reader.once('close', () => {
      if (!this.closed) this.fail(new StackQLConnectionError('stream'));
    });
    this.child.once('error', () => {
      this.fail(new StackQLConnectionError('startup'));
    });
    this.child.once('close', () => {
      if (!this.closed) this.fail(new StackQLConnectionError('exited'));
    });
    this.child.stdin.on('error', () => this.fail(new StackQLConnectionError('input')));
    this.child.stderr.on('data', () => {});
  }

  onLine(line) {
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
      this.fail(new StackQLConnectionError('oversized'));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new StackQLConnectionError('invalid_protocol'));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.fail(new StackQLConnectionError('invalid_protocol'));
      return;
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(message.id);
    if (message.error) {
      waiting.reject(new Error(`StackQL MCP request failed (${message.error.code ?? 'protocol error'}).`));
    } else {
      waiting.resolve(message.result);
    }
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('StackQL MCP connection is closed.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.fail(new StackQLConnectionError('timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (!error) return;
        this.fail(new StackQLConnectionError('write'));
      });
    });
  }

  notify(method, params = {}) {
    if (this.failure || this.closed) throw this.failure ?? new Error('StackQL MCP connection is closed.');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, (error) => {
      if (error) this.fail(new StackQLConnectionError('write'));
    });
  }

  async initialize() {
    const initialized = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'cost-sweeper-sdk', version: '0.1.0' },
    });
    if (!initialized?.serverInfo) throw new Error('StackQL MCP did not identify its server.');
    if (initialized.instructions !== undefined && typeof initialized.instructions !== 'string') {
      throw new Error('StackQL MCP returned invalid initialization instructions.');
    }
    this.instructions = initialized.instructions ?? '';
    this.notify('notifications/initialized');
    const listed = await this.request('tools/list');
    if (!Array.isArray(listed?.tools)) throw new Error('StackQL MCP returned an invalid tool listing.');
    const actual = new Set();
    for (const tool of listed.tools) {
      if (!tool || typeof tool.name !== 'string' || !EXPECTED_TOOLS.has(tool.name)
        || actual.has(tool.name) || !tool.inputSchema || typeof tool.inputSchema !== 'object'
        || Array.isArray(tool.inputSchema)) {
        throw new Error('StackQL MCP exposed an unexpected or invalid tool definition.');
      }
      actual.add(tool.name);
      this.tools.set(tool.name, tool);
    }
    if (actual.size !== EXPECTED_TOOLS.size || [...EXPECTED_TOOLS].some((name) => !actual.has(name))) {
      throw new Error('StackQL MCP did not expose the complete configured read-only tool allowlist.');
    }
    const info = await this.callTool('server_info', {});
    const text = (info.content ?? []).filter((item) => item?.type === 'text').map((item) => item.text).join('\n');
    if (!/^mode:\s*read_only\s*$/m.test(text) || !/^is_read_only:\s*true\s*$/m.test(text)) {
      throw new Error('StackQL MCP did not confirm read_only mode.');
    }
    return this;
  }

  async callTool(name, arguments_) {
    if (!EXPECTED_TOOLS.has(name) || !this.tools.has(name) && name !== 'server_info') {
      throw new Error('The requested StackQL operation is not allowlisted.');
    }
    const result = await this.request('tools/call', { name, arguments: arguments_ });
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.isError === true) {
      throw new Error(`The read-only StackQL ${name} call failed. Re-check discovered metadata and report a safe coverage gap.`);
    }
    return result;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
      }, 5000);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }
}

export async function connectStackQL(server, options) {
  const client = new StackQLClient(server, options);
  try {
    await client.initialize();
    if (server.auditPath && (await stat(server.auditPath)).size === 0) {
      throw new Error('StackQL MCP completed its handshake but wrote no native JSONL audit records.');
    }
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
