import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildClientOptions, executeSweep } from '../scripts/copilot.mjs';
import { resolveSweepContext } from '../scripts/context.mjs';
import { GroundingGuard } from '../scripts/grounding.mjs';
import { projectRoot } from '../scripts/runtime.mjs';
import { readOnlyTools } from '../scripts/stackql-mcp.mjs';
import { runProviderWorker, createWorkerTools, createUsageCollector, providerResultSchema, validateProviderSubmission } from '../scripts/sweep.mjs';
import { createProgressLogger, renderSweepTables, visibleWidth } from '../scripts/console.mjs';
import { QueryLibrarySuggestions, parameterizeQuery, publishQueryLibrarySuggestions } from '../scripts/query-library-suggestions.mjs';

async function temporaryRoot(t) {
  await mkdir(join(projectRoot, '.stackql'), { recursive: true });
  const root = await mkdtemp(join(projectRoot, '.stackql', 'cost-sweeper-sdk-test-'));
  await mkdir(join(root, 'config'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'config', 'system.md'), 'Use evidence from read-only inventory.');
  await writeFile(join(root, 'config', 'aws.md'), 'Inspect AWS account scope.');
  await writeFile(join(root, 'config', 'azure.md'), 'Inspect Azure subscription scope.');
  await writeFile(join(root, 'docs', 'report-format.md'), 'Report shape contract.');
  await writeFile(join(root, '.env'), '# empty test file\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function failedResult(provider) {
  return {
    name: provider,
    status: 'failed',
    coverage: [],
    gaps: [],
    errors: ['Test-only access failure.'],
    findings: [],
    recommendations: [],
    resources: [],
    spend: null,
  };
}

function toolMetadata() {
  return new Map(readOnlyTools.map((name) => [name, {
    name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  }]));
}

function setTerminalType(t, value) {
  const previous = process.env.TERM;
  process.env.TERM = value;
  t.after(() => {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  });
}

class FakeSession {
  constructor(config, result, usage) {
    this.config = config;
    this.result = result;
    this.usage = usage;
    this.sessionId = `fake-${result.name}`;
    this.handlers = new Map();
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  }

  async sendAndWait(options) {
    this.handlers.get('assistant.usage')?.({ data: {
      model: 'copilot-test-model', inputTokens: 120, outputTokens: 30,
      cacheReadTokens: 20, cacheWriteTokens: 5,
    } });
    assert.deepEqual(options.responseSchema, providerResultSchema(this.result.name));
    return { data: { content: JSON.stringify(this.result) } };
  }

  async disconnect() {}
}

class FakeClient {
  constructor(results) {
    this.results = results;
    this.sessions = [];
    this.deleted = [];
    this.started = false;
    this.stopped = false;
  }

  async start() {
    this.started = true;
  }

  async createSession(config) {
    const provider = this.results[this.sessions.length].name;
    const session = new FakeSession(config, this.results[this.sessions.length]);
    this.sessions.push({ provider, session, config });
    return session;
  }

  async stop() {
    this.stopped = true;
    return [];
  }

  async deleteSession(sessionId) {
    this.deleted.push(sessionId);
  }
}

test('host resolves selected prose and authoritative UTC billing boundaries at sweep start', async (t) => {
  const root = await temporaryRoot(t);
  const now = new Date('2026-11-16T08:59:10+11:00');
  const context = await resolveSweepContext(['aws'], root, now);
  assert.deepEqual(context.providers, ['aws']);
  assert.equal(context.generatedAt, '2026-11-15T21:59:10.000Z');
  assert.deepEqual(context.billingWindow.previous7Days, { startInclusive: '2026-11-01', endExclusive: '2026-11-08' });
  assert.deepEqual(context.billingWindow.recent7Days, { startInclusive: '2026-11-08', endExclusive: '2026-11-15' });
  assert.equal(context.billingWindow.lastEligibleDate, '2026-11-14');
  assert.equal(context.systemPolicy, 'Use evidence from read-only inventory.');
  assert.deepEqual(context.providerPolicies, [{ provider: 'aws', text: 'Inspect AWS account scope.' }]);
  assert.equal(context.reportContract, 'Report shape contract.');
});

test('Copilot SDK uses the managed empty runtime and existing Copilot sign-in', () => {
  const options = buildClientOptions({ environment: { COPILOT_HOME: 'C:\\Users\\test\\.copilot' }, userHome: 'C:\\Users\\test' });
  assert.equal(options.mode, 'empty');
  assert.equal(options.baseDirectory, 'C:\\Users\\test\\.copilot');
  assert.equal(options.useLoggedInUser, true);
  assert.equal(options.logLevel, 'error');
  assert.equal(Object.hasOwn(options, 'gitHubToken'), false);
  assert.equal(Object.hasOwn(options, 'provider'), false);
});

test('one isolated SDK session per selected provider is restricted, parallel, and fully collated', async (t) => {
  const root = await temporaryRoot(t);
  const client = new FakeClient([failedResult('aws'), failedResult('azure')]);
  const progress = [];
  const outputs = [];
  let stackqlStarts = 0;
  let stackqlCloses = 0;
  const fakeStackQL = {
    tools: toolMetadata(),
    failure: null,
    async close() { stackqlCloses += 1; },
  };
  const result = await executeSweep([], {
    root,
    now: new Date('2026-11-16T00:00:00Z'),
    createClient: () => client,
    openStackQL: async () => { stackqlStarts += 1; return fakeStackQL; },
    onProgress: (event) => progress.push(event),
    writeOutput: (text) => outputs.push(text),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(client.started, true);
  assert.equal(client.stopped, true);
  assert.deepEqual(client.deleted.sort(), ['fake-aws', 'fake-azure']);
  assert.equal(stackqlStarts, 1);
  assert.equal(stackqlCloses, 1);
  assert.deepEqual(client.sessions.map((item) => item.provider), ['aws', 'azure']);
  for (const { config, provider } of client.sessions) {
    assert.equal(config.model, 'auto');
    assert.equal(config.clientName, 'cost-sweeper');
    assert.equal(config.workingDirectory, projectRoot);
    assert.equal(config.enableSessionStore, false);
    assert.deepEqual(config.infiniteSessions, { enabled: false });
    assert.equal(config.enableConfigDiscovery, false);
    assert.deepEqual(config.mcpServers, {});
    assert.deepEqual(config.disabledMcpServers, ['stackql', 'cost-sweeper-stackql']);
    assert.deepEqual(config.availableTools, readOnlyTools.map((name) => `stackql_${name}`));
    assert.equal(config.tools.some((tool) => tool.name === 'shell' || tool.name.includes('filesystem')), false);
    assert.match(config.systemMessage.content, new RegExp(`selected StackQL registry provider "${provider}"`));
    assert.match(config.systemMessage.content, /untrusted evidence/);
  }
  assert.equal(outputs.length, 2);
  assert.equal(result.suggestionsPath, join(root, 'output', 'query_library_suggestions_2026-11-16-00-00-00.md'));
  const suggestions = await readFile(result.suggestionsPath, 'utf8');
  assert.match(suggestions, /^# aws$/m);
  assert.match(suggestions, /^# azure$/m);
  assert.match(suggestions, /No unresolved library searches/);
  assert.match(outputs[1], /Query library suggestions saved/);
  assert.equal((await readdir(root)).includes('outputs'), false, 'suggestions do not opt into a financial Markdown report');
  assert.match(outputs[0], /Provider/);
  assert.match(outputs[0], /copilot-test-model/);
  assert.match(outputs[0], /Input/);
  assert.deepEqual(progress.filter((entry) => entry.provider && ['starting', 'failed'].includes(entry.status))
    .map((entry) => entry.provider).sort(), ['aws', 'aws', 'azure', 'azure']);
  assert.ok(progress.some((entry) => entry.status === 'running' && entry.provider === 'aws'));
});

test('query library suggestions group misses by provider and prompt and deduplicate parameterized executed queries', async (t) => {
  const root = await temporaryRoot(t);
  const suggestions = new QueryLibrarySuggestions(['aws', 'azure']);
  const search = { intent: 'list resources with daily cost', service: 'ec2' };
  const response = { structuredContent: { hits: [], miss: true, stale: false } };
  suggestions.record('aws', 'query_library_search', search, response);
  suggestions.record('aws', 'query_library_search', search, response);
  for (const region of ['private-region-one', 'private-region-two']) {
    suggestions.record('aws', 'run_select_query', {}, { structuredContent: { rows: [] } }, {
      query: `SELECT id FROM aws.ec2.instances WHERE region = '${region}' AND account = 'private-account' LIMIT 10;`,
      tables: ['aws.ec2.instances'],
    });
  }
  suggestions.record('azure', 'query_library_search', { intent: 'list provisioned databases', service: 'sql' }, null);
  const path = await publishQueryLibrarySuggestions(suggestions, '2026-11-16T00:00:00.000Z', root);
  const markdown = await readFile(path, 'utf8');
  assert.match(markdown, /^# aws$/m);
  assert.match(markdown, /^# azure$/m);
  assert.match(markdown, /^## Prompt: list resources with daily cost$/m);
  assert.match(markdown, /Attempts: 2/);
  assert.match(markdown, /2 successful execution/);
  assert.equal((markdown.match(/### Proposed entry/g) ?? []).length, 1);
  assert.match(markdown, /query-library\/queries\/aws\/ec2\/list-resources-with-daily-cost\.md/);
  assert.match(markdown, /status: "draft"/);
  assert.match(markdown, /## Query/);
  assert.match(markdown, /## Notes/);
  assert.match(markdown, /region = '\{\{region\}\}'/);
  assert.match(markdown, /account = '\{\{account\}\}'/);
  assert.doesNotMatch(markdown, /private-region|private-account|LIMIT 10|status: "stable"/);
  assert.match(markdown, /Not ready for import/);
  assert.match(markdown, /Search failed; a catalogue gap is not established/);
  assert.match(markdown, /No new executable query was established/);
  await assert.rejects(publishQueryLibrarySuggestions(suggestions, '2026-11-16T00:00:00.000Z', root), /never overwritten/);
  assert.equal(await readFile(path, 'utf8'), markdown);
});

test('query library suggestions omit executed existing entries and never promote guard-rejected queries', async () => {
  const suggestions = new QueryLibrarySuggestions(['aws']);
  const sql = "SELECT id FROM aws.ec2.instances WHERE region = 'test-region';";
  suggestions.record('aws', 'query_library_search', { intent: 'list instances', service: 'ec2' },
    { structuredContent: { hits: [{ id: 'aws/ec2/instances-list' }], miss: false } });
  suggestions.record('aws', 'query_library_get', { id: 'aws/ec2/instances-list' },
    { structuredContent: { id: 'aws/ec2/instances-list', valid: true, sql } });
  suggestions.record('aws', 'run_select_query', {}, { structuredContent: { rows: [] } },
    { query: sql, tables: ['aws.ec2.instances'] });
  assert.doesNotMatch(suggestions.render('2026-11-16T00:00:00Z'), /### Proposed entry|## Prompt/);
  let executed = false;
  const { tools } = createWorkerTools('aws', '2026-11-16T00:00:00Z', {
    tools: toolMetadata(), async callTool() { executed = true; },
  }, { value: null }, () => {}, (...args) => suggestions.record(...args));
  const result = await tools.find((tool) => tool.name === 'stackql_run_select_query').handler({ sql });
  assert.equal(result.resultType, 'failure');
  assert.equal(executed, false);
  assert.doesNotMatch(suggestions.render('2026-11-16T00:00:00Z'), /### Proposed entry/);
});

test('draft query parameters remove escaped strings and numeric literals without changing metadata identifiers', () => {
  const { template, params } = parameterizeQuery("SELECT JSON_EXTRACT(data, '$.items[0].name') FROM aws.ec2.instances WHERE label = 'private''label' AND limit_value = -10.5;");
  assert.match(template, /aws\.ec2\.instances/);
  assert.doesNotMatch(template, /private|items|10\.5/);
  assert.equal(params.length, 3);
  assert.equal(params[2].type, 'number');
  assert.deepEqual([...template.matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map((match) => match[1]), params.map((param) => param.name));
});

test('tables fit narrow terminal viewports without dropping long resource and evidence text', () => {
  const provider = failedResult('aws');
  provider.errors = ['A long actionable message: ' + 'account-access '.repeat(20)];
  const report = { generatedAt: '2026-11-16T00:00:00Z', summary: 'Summary '.repeat(40), providers: [provider] };
  const usage = createUsageCollector();
  usage.models.set('long-copilot-model-name', {
    calls: 1, inputTokens: 123, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, incomplete: false,
  });
  for (const columns of [24, 40, 60, 80, 100]) {
    const output = renderSweepTables(report, usage, 115516, columns, false);
    assert.ok(output.split('\n').every((line) => line.length < columns), `Overflow at ${columns} columns`);
    const colored = renderSweepTables(report, usage, 115516, columns, true);
    assert.match(colored, /\x1b\[1;96m/);
    assert.match(colored, /\x1b\[96m┌/);
    assert.ok(colored.split('\n').every((line) => visibleWidth(line) < columns));
    assert.match(output, /┌[─┬]+┐/);
    assert.doesNotMatch(output, /^\+/m);
    const text = output.split('\n').filter((line) => line.startsWith('│'))
      .map((line) => line.slice(2, -2).replace(/ │ /g, ' ').trim()).join('');
    assert.ok(text.includes('account-access'));
    assert.match(output, /Copilot usage/);
    assert.match(output, /115\.516/);
  }
});

test('guard failure delivers correctable feedback without the SDK rejected result that ends a run', async () => {
  let called = false;
  const { tools, acceptStructuredResult } = createWorkerTools('aws', '2026-11-16T00:00:00Z', {
    tools: toolMetadata(), async callTool() { called = true; },
  }, { value: null });
  const result = await tools.find((tool) => tool.name === 'stackql_list_services').handler({ provider: 'aws' });
  assert.equal(result.resultType, 'failure');
  assert.match(result.textResultForLlm, /server_info first/);
  assert.equal(called, false);
  assert.throws(() => acceptStructuredResult({}), /exactly/);
  assert.equal(tools.some((tool) => tool.name === 'submit_provider_result'), false);
  assert.deepEqual(providerResultSchema('aws').required,
    ['name', 'status', 'coverage', 'gaps', 'errors', 'findings', 'recommendations', 'resources', 'spend']);
});

test('installed-provider discovery handles a no-argument schema and uses structured rows over Markdown', async () => {
  const definitions = [
    { name: 'server_info', inputSchema: { type: 'object' } },
    { name: 'list_registry', inputSchema: { type: 'object', properties: { format: { type: 'string' } } } },
    { name: 'list_providers', inputSchema: { type: 'object' } },
    { name: 'list_services', inputSchema: { type: 'object', properties: {
      provider: { type: 'string' }, format: { type: 'string' },
    } } },
  ];
  const calls = [];
  const stackql = {
    tools: new Map(definitions.map((tool) => [tool.name, tool])),
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'server_info') return { content: [{ type: 'text', text: 'mode: read_only\nis_read_only: true' }] };
      if (name === 'list_registry') return { structuredContent: { rows: [{ provider: 'aws', versions: 'v1, v2' }] } };
      if (name === 'list_providers') return {
        content: [{ type: 'text', text: '| name | version |\n| aws | v2 |' }],
        structuredContent: { rows: [{ name: 'aws', version: 'v2' }, { name: 'stackql_preview', version: 'internal' }] },
      };
      return { structuredContent: { rows: [] } };
    },
  };
  const { tools } = createWorkerTools('aws', '2026-11-16T00:00:00Z', stackql, { value: null });
  const tool = (name) => tools.find((item) => item.name === `stackql_${name}`);
  assert.deepEqual(tool('list_providers').parameters.properties, {});
  await tool('server_info').handler();
  await tool('list_registry').handler({});
  assert.equal(calls[1].args.format, 'json');
  const result = await tool('list_providers').handler(null);
  assert.deepEqual(JSON.parse(result).rows[0], { name: 'aws', version: 'v2' });
  assert.deepEqual(calls[2].args, {});
  assert.equal(typeof await tool('list_services').handler({ provider: 'aws' }), 'string');
  assert.equal(calls[3].args.format, 'json');
});

test('overlapping parent discovery calls wait for completed evidence before checking the next guard', async () => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const events = [];
  const metadata = toolMetadata();
  metadata.get('list_registry').inputSchema.properties = { format: { type: 'string' } };
  const { tools } = createWorkerTools('aws', '2026-11-16T00:00:00Z', {
    tools: metadata,
    async callTool(name) {
      calls.push(name);
      if (name === 'server_info') {
        await ready;
        return { content: [{ type: 'text', text: 'mode: read_only\nis_read_only: true' }] };
      }
      return { structuredContent: { rows: name === 'list_registry'
        ? [{ provider: 'aws', version: 'v1' }] : [{ name: 'aws', version: 'v1' }] } };
    },
  }, { value: null }, (event) => events.push(event));
  const call = (name) => tools.find((tool) => tool.name === `stackql_${name}`).handler({});
  const results = Promise.all([call('server_info'), call('list_registry'), call('list_providers')]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['server_info']);
  release();
  assert.ok((await results).every((result) => typeof result === 'string'));
  assert.deepEqual(calls, ['server_info', 'list_registry', 'list_providers']);
  assert.equal(events.some((event) => event.status === 'warning'), false);
});

test('SDK completion without a final assistant response is resumed without losing the provider worker', async (t) => {
  const root = await temporaryRoot(t);
  const context = await resolveSweepContext(['aws'], root);
  let calls = 0;
  const events = [];
  const client = {
    async createSession() {
      return {
        on() {},
        async sendAndWait(options) {
          calls++;
          if (calls === 1) throw new Error('The requested run completed without a structured assistant response.');
          assert.match(options.prompt, /Retain collected evidence and finalize/);
          return { data: { content: JSON.stringify(failedResult('aws')) } };
        },
        async disconnect() {},
      };
    },
  };
  const result = await runProviderWorker('aws', context, client, createUsageCollector(), {
    openStackQL: async () => ({ tools: toolMetadata() }), closeStackQL: false,
    onProgress: (event) => events.push(event),
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, failedResult('aws'));
  assert.ok(events.some((event) => event.status === 'continuing'));
});

test('structured output retries invalid evidence within one budget without a voluntary submission tool', async (t) => {
  const root = await temporaryRoot(t);
  const context = await resolveSweepContext(['aws'], root);
  for (const shouldSubmit of [true, false]) {
    let calls = 0;
    const budgets = [];
    const prompts = [];
    const events = [];
    const client = {
      async createSession(config) {
        assert.equal(config.tools.some((tool) => tool.name === 'submit_provider_result'), false);
        return {
          on() {},
          async sendAndWait(options, timeout) {
            budgets.push(timeout);
            prompts.push(options.prompt);
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            assert.deepEqual(options.responseSchema, providerResultSchema('aws'));
            return { data: { content: JSON.stringify(shouldSubmit && calls === 2 ? failedResult('aws') : {}) } };
          },
          async disconnect() {},
        };
      },
    };
    const result = await runProviderWorker('aws', context, client, createUsageCollector(), {
      openStackQL: async () => ({ tools: toolMetadata() }), closeStackQL: false,
      timeoutMs: 1000, onProgress: (event) => events.push(event),
    });
    assert.equal(calls, shouldSubmit ? 2 : 3);
    assert.ok(budgets.every((budget) => budget <= 1000));
    assert.ok(budgets[1] < budgets[0], 'recovery does not restart the timeout');
    assert.match(prompts[1], /Correct this validation issue using collected evidence: Provider result must contain exactly/);
    assert.ok(events.some((event) => event.status === 'continuing'));
    if (shouldSubmit) assert.deepEqual(result, failedResult('aws'));
    else assert.match(result.errors[0], /schema-valid provider evidence/);
  }
});

test('progress has restrained optional color and wraps within the terminal width', () => {
  let output = '';
  const logger = createProgressLogger({ stream: { columns: 60, write: (value) => { output += value; } }, color: true });
  logger({ provider: 'aws', status: 'failed', detail: 'Safe actionable failure. '.repeat(5) });
  assert.match(output, /\x1b\[31m/);
  assert.ok(output.trimEnd().split('\n').every((line) => visibleWidth(line) < 60));
  output = '';
  createProgressLogger({ stream: { columns: 60, write: (value) => { output += value; } }, color: false })({
    provider: 'aws', status: 'working', detail: 'list_services', elapsedSeconds: 15,
  });
  assert.doesNotMatch(output, /\x1b/);
  assert.match(output, /15s elapsed/);
});

test('TTY progress types quickly, animates the spinner, and replaces successive tool names in one row', (t) => {
  setTerminalType(t, 'xterm');
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const writes = [];
  const logger = createProgressLogger({
    stream: { isTTY: true, columns: 60, write: (value) => writes.push(value) }, color: true,
  });
  t.after(() => logger.stop());
  const latest = () => writes.filter((value) => value.endsWith('\n')).at(-1);
  logger({ provider: 'aws', status: 'tool', detail: 'list_resources' });
  const first = latest();
  assert.match(first, /\p{Script=Braille}/u);
  assert.doesNotMatch(first, /list_resources/);
  t.mock.timers.tick(16);
  assert.match(latest(), /lis/);
  assert.doesNotMatch(latest(), /list_resources/);
  t.mock.timers.tick(104);
  assert.match(latest(), /\[aws\] tool use: list_resources/);
  assert.notEqual(latest().match(/\p{Script=Braille}/u)[0], first.match(/\p{Script=Braille}/u)[0]);
  logger({ provider: 'aws', status: 'tool', detail: 'run_select_query' });
  t.mock.timers.tick(160);
  assert.match(latest(), /run_select_query/);
  assert.doesNotMatch(latest(), /list_resources/);
  assert.equal(latest().trimEnd().split('\n').length, 1);
  assert.ok(writes.includes('\x1b[1A\r\x1b[J'));
  assert.ok(latest().split('\n').every((line) => visibleWidth(line) < 60));
  logger.stop();
  assert.equal(writes.at(-1), '\x1b[?25h');
  const count = writes.length;
  t.mock.timers.tick(1000);
  assert.equal(writes.length, count, 'animation cannot repaint after stopping');
});

test('parallel provider progress preserves separate live rows and permanent warnings while fitting resize', (t) => {
  setTerminalType(t, 'xterm');
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const writes = [];
  const stream = { isTTY: true, columns: 80, write: (value) => writes.push(value) };
  const logger = createProgressLogger({ stream, color: false });
  t.after(() => logger.stop());
  const latest = () => writes.filter((value) => value.endsWith('\n')).at(-1);
  logger({ provider: 'aws', status: 'tool', detail: 'list_resources' });
  logger({ provider: 'azure', status: 'tool', detail: 'describe_method' });
  t.mock.timers.tick(160);
  assert.match(latest(), /\[aws\] tool use: list_resources/);
  assert.match(latest(), /\[azure\] tool use: describe_method/);
  assert.equal(latest().trimEnd().split('\n').length, 2);
  logger({ provider: 'aws', status: 'warning', detail: 'Correct the query using described fields.' });
  assert.ok(writes.some((value) => value.includes('[aws] warning: Correct the query')));
  logger({ provider: 'aws', status: 'working', detail: 'a redundant completed message', elapsedSeconds: 15 });
  assert.match(latest(), /list_resources \| 15s elapsed/);
  assert.doesNotMatch(latest(), /redundant completed/);
  stream.columns = 28;
  t.mock.timers.tick(120);
  assert.ok(latest().split('\n').every((line) => visibleWidth(line) < 28));
  assert.ok(writes.includes('\x1b[2A\r\x1b[J'));
  logger({ provider: 'aws', status: 'partial', detail: 'Coverage incomplete.' });
  assert.doesNotMatch(latest(), /\[aws\]/);
  assert.match(latest(), /\[azure\]/);
});

test('redirected and dumb-terminal progress collapse tool history without animation or cursor control', (t) => {
  setTerminalType(t, 'dumb');
  let output = '';
  for (const isTTY of [false, true]) {
    output = '';
    const logger = createProgressLogger({ stream: { isTTY, columns: 80, write: (value) => { output += value; } }, color: false });
    for (const detail of ['list_resources', 'list_methods', 'describe_method', 'run_select_query']) {
      logger({ provider: 'aws', status: 'tool', detail });
    }
    logger({ provider: 'aws', status: 'working', detail: 'run_select_query completed', elapsedSeconds: 15 });
    assert.equal(output, '');
    logger({ provider: 'aws', status: 'complete', detail: 'Inventory accepted.' });
    logger.stop();
    assert.match(output, /\[aws\] tool use: run_select_query/);
    assert.doesNotMatch(output, /list_resources|list_methods|describe_method|\x1b|\p{Script=Braille}/u);
    assert.equal(output.trimEnd().split('\n').length, 2);
  }
});

test('the sweep stops progress before report output and also on pre-runtime startup failure', async (t) => {
  const root = await temporaryRoot(t);
  let stopped = 0;
  const onProgress = () => {};
  onProgress.stop = () => { stopped++; };
  await executeSweep(['aws'], {
    root, createClient: () => new FakeClient([failedResult('aws')]),
    openStackQL: async () => ({ tools: toolMetadata(), async close() {} }),
    onProgress, writeOutput: () => assert.equal(stopped, 1),
  });
  assert.equal(stopped, 1);
  await rm(join(root, '.env'));
  await assert.rejects(executeSweep(['aws'], { root, onProgress }), /Missing local .env/);
  assert.equal(stopped, 2);
});

test('structured final responses cannot bypass JSON parsing or observed inventory grounding', async (t) => {
  const root = await temporaryRoot(t);
  const context = await resolveSweepContext(['aws'], root);
  const invented = {
    ...failedResult('aws'), status: 'partial',
    resources: [{
      id: 'unobserved', service: 'ec2', scope: 'unknown', region: 'unknown', state: 'unknown',
      currency: null, dailyCost: null, confidence: 'unknown', basis: 'Unknown', source: 'Unknown', assumptions: [],
    }],
  };
  for (const content of ['private response body, not JSON', JSON.stringify(invented)]) {
    const events = [];
    let calls = 0;
    const client = {
      async createSession() {
        return {
          on() {},
          async sendAndWait() { calls++; return { data: { content } }; },
          async disconnect() {},
        };
      },
    };
    const result = await runProviderWorker('aws', context, client, createUsageCollector(), {
      openStackQL: async () => ({ tools: toolMetadata() }), closeStackQL: false,
      onProgress: (event) => events.push(event),
    });
    assert.equal(calls, 3);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.resources, []);
    assert.doesNotMatch(JSON.stringify({ result, events }), /private response body/);
    assert.ok(events.some((event) => event.status === 'warning' &&
      (content.startsWith('{') ? /not discovered/.test(event.detail) : /not valid provider JSON/.test(event.detail))));
  }
});

test('worker failures report safe categorized reasons and emit heartbeat during model waits', async (t) => {
  const root = await temporaryRoot(t);
  const context = await resolveSweepContext(['aws'], root);
  for (const errorType of ['quota', 'rate_limit', 'authentication']) {
    const events = [];
    const handlers = new Map();
    const client = {
      async createSession() {
        return {
          on: (name, handler) => handlers.set(name, handler),
          async sendAndWait() {
            await new Promise((resolve) => setTimeout(resolve, 25));
            handlers.get('session.error')({ data: { errorType } });
            throw new Error('private raw payload must not appear');
          },
          async disconnect() {},
        };
      },
    };
    const result = await runProviderWorker('aws', context, client, createUsageCollector(), {
      openStackQL: async () => ({ tools: toolMetadata() }),
      closeStackQL: false, heartbeatMs: 5, onProgress: (event) => events.push(event),
    });
    assert.equal(result.status, 'failed');
    assert.ok(events.some((event) => event.status === 'working'));
    assert.ok(events.some((event) => event.status === 'failed' && event.detail === result.errors[0]));
    assert.doesNotMatch(JSON.stringify({ result, events }), /private raw payload/);
    assert.match(result.errors[0], errorType === 'quota' ? /allowance/ : errorType === 'rate_limit' ? /rate limit/ : /authentication/);
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(events.length, count, 'heartbeat stopped after completion');
  }
});

test('strict provider submission rejects extra fields and incomplete complete-status evidence', () => {
  const generatedAt = '2026-11-16T00:00:00.000Z';
  const result = failedResult('aws');
  assert.throws(() => validateProviderSubmission({ ...result, secret: 'not allowed' }, 'aws', generatedAt), /exactly/);
  assert.throws(() => validateProviderSubmission({ ...result, name: 'azure' }, 'aws', generatedAt), /must be aws/);
  const falselyComplete = {
    ...result,
    status: 'complete',
    coverage: ['All required services inspected.'],
    errors: [],
  };
  assert.throws(() => validateProviderSubmission(falselyComplete, 'aws', generatedAt), /spending history|Invalid report/);
});

test('grounding guard enforces registry-backed parent discovery and observed resource fields', () => {
  const guard = new GroundingGuard('aws');
  const schema = (properties) => ({ type: 'object', properties });
  const response = (structuredContent) => ({ structuredContent, content: [] });
  const serverInfo = { content: [{ type: 'text', text: 'mode: read_only\nis_read_only: true' }] };
  guard.after('server_info', {}, {}, serverInfo);
  assert.throws(() => guard.before('list_providers', {}, schema({})), /Inspect list_registry/);
  const registrySchema = schema({
    provider: { type: 'string' }, version: { type: 'string' }, format: { type: 'string' },
    row_limit: { type: 'integer' },
  });
  guard.before('list_registry', { format: 'json' }, registrySchema);
  guard.after('list_registry', { format: 'json' }, registrySchema, response({
    rows: [{ provider: 'aws', version: 'v1' }, { provider: 'azure', version: 'v2' }],
  }));
  guard.after('list_registry', { provider: 'aws', format: 'json' }, registrySchema, response({
    rows: [{ provider: 'aws', versions: 'v1, v2' }],
  }));
  assert.deepEqual([...guard.registryVersions.get('aws')], ['v1', 'v2']);
  const pullSchema = schema({ provider: { type: 'string' }, version: { type: 'string' } });
  assert.throws(() => guard.before('pull_provider', { provider: 'aws', version: 'unlisted' }, pullSchema), /exact provider version/);
  guard.before('pull_provider', { provider: 'aws', version: 'v1' }, pullSchema);
  guard.after('pull_provider', { provider: 'aws', version: 'v1' }, pullSchema, response({}));
  const providersSchema = schema({});
  guard.after('list_providers', {}, providersSchema, response({ rows: [{ name: 'aws', version: 'old' }] }));
  const listSchema = schema({
    provider: { type: 'string' }, format: { type: 'string' }, row_limit: { type: 'integer' },
  });
  assert.throws(() => guard.before('list_services', { provider: 'aws', format: 'json' }, listSchema),
    /Confirm the selected provider/);
  guard.after('list_providers', {}, providersSchema, response({ rows: [{ name: 'aws', version: 'v1' }] }));
  guard.before('list_services', { provider: 'aws', format: 'json' }, listSchema);
  guard.after('list_services', { provider: 'aws', format: 'json' }, listSchema,
    response({ rows: [{ name: 'ec2', title: 'Amazon EC2' }] }));
  const resourceSchema = schema({
    provider: { type: 'string' }, service: { type: 'string' }, format: { type: 'string' },
    row_limit: { type: 'integer' },
  });
  guard.before('list_resources', { provider: 'aws', service: 'ec2', format: 'json' }, resourceSchema);
  guard.after('list_resources', { provider: 'aws', service: 'ec2', format: 'json' }, resourceSchema,
    response({ rows: [{ name: 'instances' }] }));
  const methodSchema = schema({
    provider: { type: 'string' }, service: { type: 'string' }, resource: { type: 'string' },
    format: { type: 'string' }, row_limit: { type: 'integer' },
  });
  guard.before('list_methods', { provider: 'aws', service: 'ec2', resource: 'instances', format: 'json' }, methodSchema);
  guard.after('list_methods', { provider: 'aws', service: 'ec2', resource: 'instances', format: 'json' }, methodSchema,
    response({
      rows: [
        { MethodName: 'DescribeInstances', SQLVerb: 'SELECT' },
        { MethodName: 'CreateInstance', SQLVerb: 'INSERT' },
      ],
    }));
  const describeSchema = schema({
    provider: { type: 'string' }, service: { type: 'string' }, resource: { type: 'string' },
    method: { type: 'string' }, format: { type: 'string' },
  });
  guard.before('describe_method', {
    provider: 'aws', service: 'ec2', resource: 'instances', method: 'DescribeInstances', format: 'json',
  }, describeSchema);
  assert.throws(() => guard.before('describe_method', {
    provider: 'aws', service: 'ec2', resource: 'instances', method: 'CreateInstance', format: 'json',
  }, describeSchema), /exact SELECT method/);
  guard.after('describe_method', {
    provider: 'aws', service: 'ec2', resource: 'instances', method: 'DescribeInstances', format: 'json',
  }, describeSchema, response({ rows: [
    { name: 'instanceId', param_type: 'output', type: 'string' },
    { name: 'state', param_type: 'output', type: 'string' },
    { name: 'region', param_type: 'input_optional', type: 'string' },
  ] }));
  const query = 'SELECT instanceId, state FROM aws.ec2.instances';
  const querySchema = schema({ query: { type: 'string' } });
  assert.throws(() => guard.before('validate_select_query', {
    query: 'SELECT accountId, state FROM aws.ec2.instances',
  }, querySchema), /not returned as an output/);
  const queryContext = guard.before('validate_select_query', { query }, querySchema);
  assert.throws(() => guard.after('validate_select_query', { query }, querySchema,
    response({ valid: false, errors: ['invalid query'] }), queryContext), /rejected or could not verify/);
  assert.throws(() => guard.after('validate_select_query', { query }, querySchema,
    response({ errors: [] }), queryContext), /rejected or could not verify/);
  assert.throws(() => guard.before('run_select_query', { query }, querySchema), /Validate this exact SELECT/);
  guard.after('validate_select_query', { query }, querySchema, response({ valid: true, errors: [] }), queryContext);
  guard.after('validate_select_query', { query }, querySchema, response({ valid: true }), queryContext);
  guard.after('validate_select_query', { query }, querySchema, response({ valid: true, errors: null }), queryContext);
  assert.throws(() => guard.after('validate_select_query', { query }, querySchema,
    response({ valid: true, errors: ['error'] }), queryContext), /rejected or could not verify/);
  assert.throws(() => guard.before('run_select_query', { query: `${query} WHERE state = 'running'` }, querySchema), /exact SELECT query/);
  const runContext = guard.before('run_select_query', { query }, querySchema);
  assert.doesNotThrow(() => guard.after('run_select_query', { query }, querySchema,
    response({ rows: [] }), runContext), 'successful empty SELECT is not an error');
  guard.after('validate_select_query', { query }, querySchema, response({ valid: true }), queryContext);
  guard.after('run_select_query', { query }, querySchema, response({ rows: [{
    instanceId: 'i-123', state: 'running', accountId: '123456789012', region: 'us-east-1',
  }] }), runContext);
  const partial = {
    ...failedResult('aws'),
    status: 'partial',
    coverage: ['AWS resource query completed.'],
    gaps: ['Billing history unavailable.'],
    errors: [],
    resources: [{
      id: 'i-123', service: 'ec2', scope: '123456789012', region: 'us-east-1',
      state: 'running', currency: null, dailyCost: null, confidence: 'unknown',
      basis: 'No verified price was available.', source: 'AWS SELECT evidence.',
      assumptions: [],
    }],
  };
  assert.doesNotThrow(() => validateProviderSubmission(partial, 'aws', '2026-11-16T00:00:00.000Z', guard));
  const nullValidation = guard.before('validate_select_query', { query }, querySchema);
  guard.after('validate_select_query', { query }, querySchema, response({ valid: true, errors: [] }), nullValidation);
  const nullRun = guard.before('run_select_query', { query }, querySchema);
  assert.throws(() => guard.after('run_select_query', { query }, querySchema,
    response({ rows: [{ instanceId: null, state: null }] }), nullRun), /only null or empty projections/);
  assert.throws(() => guard.before('list_resources', {
    provider: 'aws', service: 'not-discovered', format: 'json',
  }, resourceSchema), /exact service/);
  assert.throws(() => guard.before('list_resources', {
    provider: 'aws', service: 'Amazon EC2', format: 'json',
  }, resourceSchema), /exact service/);
  assert.throws(() => guard.validateProvider({
    ...partial,
    resources: [{ ...partial.resources[0], state: 'stopped' }],
  }), /not observed with that identifier/);
});

test('grounding guard rejects guessed registry versions, capped discovery, and malformed names', () => {
  const guard = new GroundingGuard('aws');
  const schema = (properties) => ({ type: 'object', properties });
  const response = (structuredContent) => ({ structuredContent, content: [] });
  guard.after('server_info', {}, {}, { content: [{ type: 'text', text: 'mode: read_only\nis_read_only: true' }] });
  const registrySchema = schema({
    provider: { type: 'string' }, version: { type: 'string' }, format: { type: 'string' },
    row_limit: { type: 'integer' },
  });
  assert.throws(() => guard.before('list_registry', { format: 'json', row_limit: 10 }, registrySchema), /Do not set row_limit/);
  guard.before('list_registry', { format: 'json' }, registrySchema);
  guard.after('list_registry', { format: 'json' }, registrySchema,
    response({ rows: [{ provider: 'azure', version: 'v1' }] }));
  const pullSchema = schema({ provider: { type: 'string' }, version: { type: 'string' } });
  assert.throws(() => guard.before('pull_provider', { provider: 'aws', version: 'v1' }, pullSchema), /exact version returned/);
  assert.throws(() => guard.after('list_providers', {}, schema({}),
    response({ rows: [{ name: 'aws' }, { version: 'v1' }] })), /exact name/);
});

test('null-projected identifiers cannot be turned into invented stopped or empty evidence', () => {
  const guard = new GroundingGuard('aws');
  guard.services.add('ec2');
  guard.observedRows.push({ values: new Set(), services: new Set(['ec2']) });
  assert.throws(() => guard.validateProvider({
    name: 'aws',
    status: 'partial',
    resources: [{
      id: 'invented-id', service: 'ec2', scope: 'unknown', region: 'unknown',
      state: 'stopped',
    }],
  }), /not observed in a successful SELECT result/);
  const emptyGuard = new GroundingGuard('aws');
  emptyGuard.selectExecutions = 1;
  assert.throws(() => emptyGuard.validateProvider({
    name: 'aws',
    status: 'complete',
    resources: [],
  }), /nonempty, non-null SELECT evidence/);
});
