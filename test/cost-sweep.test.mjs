import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRequest } from '../scripts/arguments.mjs';
import { prepareServer, readOnlyTools, resetServerLogs } from '../scripts/stackql-mcp.mjs';
import { projectRoot } from '../scripts/runtime.mjs';
import { validateReport, costSubtotals, spendingTrends, renderConsole, renderMarkdown, publishReport } from '../scripts/report.mjs';

async function temporaryRoot(t) {
  await mkdir(join(projectRoot, '.stackql'), { recursive: true });
  const directory = await mkdtemp(join(projectRoot, '.stackql', 'cost-sweeper-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function resource(overrides = {}) {
  return {
    id: 'test-instance', service: 'compute', scope: 'test-account', region: 'test-region',
    state: 'running', currency: 'USD', dailyCost: 2.4, confidence: 'high',
    basis: 'Test-only rate 0.10/hour * 24 hours/day', source: 'Test fixture, not real pricing',
    assumptions: ['24-hour runtime'], ...overrides,
  };
}

function fixture() {
  return {
    generatedAt: '2026-11-15T20:00:00Z',
    summary: 'Test fixture, not a live estate.',
    providers: [{
      name: 'aws', status: 'partial', coverage: ['Test account: compute list exhausted'],
      gaps: ['Billing history unavailable'], errors: [], findings: [], recommendations: [],
      resources: [resource()], spend: null,
    }],
  };
}

function spend() {
  return {
    source: 'Test billing fixture', basis: 'Test net costs including credits',
    daily: Array.from({ length: 14 }, (_, index) => ({
      date: `2026-11-${String(index + 1).padStart(2, '0')}`,
      currency: 'USD', amount: index < 7 ? 70 : 105, complete: true,
    })),
  };
}

test('provider scope defaults to all and positional aliases/flag order are validated', async () => {
  assert.deepEqual((await resolveRequest([])).providers, ['aws', 'azure', 'google']);
  assert.deepEqual((await resolveRequest(['all'])).providers, ['aws', 'azure', 'google']);
  const request = await resolveRequest(['--output-md', 'gcp']);
  assert.deepEqual(request.providers, ['google']);
  assert.equal(request.outputMd, true);
  assert.deepEqual((await resolveRequest(['aws', '--output-md'])).providers, ['aws']);
  for (const args of [['aws', 'azure'], ['--output-md', '--output-md'], ['--oops'], ['../../etc'], ['gcp', '--output']]) {
    await assert.rejects(resolveRequest(args));
  }
});

test('provider discovery follows prose files rather than a hard-coded provider list', async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config', 'system.md'), 'Global policy');
  await writeFile(join(root, 'config', 'digitalocean.md'), 'Provider prose');
  assert.deepEqual((await resolveRequest([], root)).providers, ['digitalocean']);
  await writeFile(join(root, 'config', 'digitalocean.md'), '');
  await assert.rejects(resolveRequest([], root), /empty/);
});

test('local MCP requires a real .env and enforces stdio read-only tools without exposing credentials', async (t) => {
  const root = await temporaryRoot(t);
  await assert.rejects(prepareServer(root), /Missing local .env/);
  await writeFile(join(root, '.env'), 'AWS_SECRET_ACCESS_KEY=test-secret-not-a-real-credential\n');
  const server = await prepareServer(root);
  const config = JSON.parse(server.args[server.args.indexOf('--mcp.config') + 1]);
  assert.equal(config.server.transport, 'stdio');
  assert.equal(config.server.mode, 'read_only');
  assert.deepEqual(config.server.audit, {
    disabled: false, format: 'jsonl', failure_mode: 'strict',
    file: { path: join(root, '.stackql', 'logs', 'stackql_mcp_server_current.jsonl'), max_size_mb: 10, max_backups: 2, max_age_days: 7 },
  });
  assert.equal(server.args[server.args.indexOf('--mcp.log.format') + 1], 'jsonl');
  assert.equal(server.auditPath, config.server.audit.file.path);
  assert.deepEqual(config.enabled_tools, readOnlyTools);
  assert.equal(server.args.includes('--mcp.server.type=stdio'), true);
  assert.equal(server.args.includes('--http.response.pageLimit=-1'), true);
  assert.equal(server.args[server.args.indexOf('--env.file') + 1], join(root, '.env'));
  assert.deepEqual(JSON.parse(server.args[server.args.indexOf('--auth') + 1]), {
    aws: {
      type: 'aws_signing_v4',
      keyIDenvvar: 'AWS_ACCESS_KEY_ID',
      credentialsenvvar: 'AWS_SECRET_ACCESS_KEY',
    },
  });
  assert.equal(JSON.stringify(server).includes('test-secret-not-a-real-credential'), false);
  assert.equal(readOnlyTools.some((name) => /mutation|lifecycle|reload/.test(name)), false);
});

test('startup resets only generated MCP logs and preserves unrelated files and directories', async (t) => {
  const root = await temporaryRoot(t);
  const cache = join(root, '.stackql');
  const logs = join(cache, 'logs');
  await mkdir(logs, { recursive: true });
  await writeFile(join(root, 'stackql_mcp_server_20261115T230811Z.log'), '');
  await writeFile(join(cache, 'stackql_mcp_server_20261115T230812Z.log'), 'synthetic fixture');
  await writeFile(join(logs, 'stackql_mcp_server_current.jsonl'), '{"fixture":true}\n');
  await writeFile(join(logs, 'stackql_mcp_server_current-2026-11-15.jsonl'), '{"fixture":true}\n');
  await writeFile(join(logs, 'keep.txt'), 'unrelated');
  await mkdir(join(root, 'stackql_mcp_server_directory.log'));
  assert.equal(await resetServerLogs(root), 4);
  assert.deepEqual((await readdir(root)).sort(), ['.stackql', 'stackql_mcp_server_directory.log']);
  assert.deepEqual(await readdir(cache), ['logs']);
  assert.deepEqual(await readdir(logs), ['keep.txt']);
  assert.equal(await resetServerLogs(root), 0);
});

test('known-cost subtotals keep currencies separate and do not treat unknown as zero', () => {
  const resources = [resource(), resource({ id: 'other', dailyCost: 0.6 }),
    resource({ id: 'eur', currency: 'EUR', dailyCost: 5 }),
    resource({ id: 'unknown', currency: null, dailyCost: null, confidence: 'unknown' })];
  assert.deepEqual(costSubtotals(resources), [['EUR', 5], ['USD', 3]]);
  const report = fixture();
  report.providers[0].resources = resources;
  report.providers[0].gaps.push('Unpriced resource');
  validateReport(report, ['aws']);
  const output = renderConsole(report, 72);
  assert.match(output, /EUR 5\.00\/day \| USD 3\.00\/day/);
  assert.match(output, /unpriced: 1/);
  assert.match(output, /UNKNOWN/);
  assert.equal(output.includes('# Cost Sweeper'), false);
  assert.equal(output.split('\n').every((line) => !line || line.length === 72), true);
});

test('seven-day comparisons use complete calendar days, not current or stale partial windows', () => {
  const report = fixture();
  const trend = spendingTrends(spend(), report.generatedAt)[0];
  assert.deepEqual(trend, {
    currency: 'USD', available: true, previousDaily: 70, recentDaily: 105, deltaDaily: 35, percent: 50,
  });
  for (const mutate of [
    (data) => data.daily.pop(),
    (data) => { data.daily[13].complete = false; },
    (data) => { data.daily[13].date = '2026-10-31'; },
  ]) {
    const data = spend();
    mutate(data);
    assert.equal(spendingTrends(data, report.generatedAt)[0].available, false);
  }
  const zero = spend();
  zero.daily.forEach((day, index) => { day.amount = index < 7 ? 0 : 10; });
  assert.equal(spendingTrends(zero, report.generatedAt)[0].percent, null);
  zero.daily.forEach((day) => { day.amount = 0; });
  assert.equal(spendingTrends(zero, report.generatedAt)[0].percent, 0);
  const mixed = spend();
  mixed.daily.push({ date: '2026-11-14', currency: 'EUR', amount: -2, complete: true });
  assert.equal(spendingTrends(mixed, report.generatedAt).find((item) => item.currency === 'EUR').available, false);
});

test('large inventories render a bounded summary while Markdown retains every evidence row', () => {
  const report = fixture();
  const provider = report.providers[0];
  provider.resources = Array.from({ length: 100 }, (_, index) => resource({
    id: `resource-${index}`, dailyCost: index,
    basis: `Formula ${index}: ` + 'evidence '.repeat(100),
  }));
  provider.spend = spend();
  provider.findings = Array.from({ length: 20 }, (_, index) => `Finding ${index}: ` + 'evidenced impact '.repeat(100));
  provider.errors = ['An explicit access failure'];
  validateReport(report, ['aws']);
  const output = renderConsole(report, 110);
  assert.ok(Buffer.byteLength(output, 'utf8') <= 12 * 1024);
  assert.match(output, /USD 4950\.00\/day/);
  assert.match(output, /Resources: 100/);
  assert.match(output, /95 additional resources not shown/);
  assert.match(output, /17 additional items not shown/);
  assert.match(output, /ERROR: An explicit access failure/);
  assert.match(output, /resource-99/);
  assert.match(output, /shortened/);
  assert.doesNotMatch(output, /Formula 99:|2026-11-01: USD/);
  const markdown = renderMarkdown(report);
  for (const row of provider.resources) {
    assert.ok(markdown.includes(`#### ${row.id}\n`));
    assert.ok(markdown.includes(row.basis.trim()));
  }
  assert.match(markdown, /Finding 19:/);
  assert.match(markdown, /2026-11-01: USD 70\.00/);
  const result = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'cost-sweep.mjs'), 'report', 'aws'], {
    input: JSON.stringify(report), encoding: 'utf8', cwd: projectRoot,
  });
  assert.equal(result.status, 2);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 12 * 1024);
  assert.match(result.stdout, /USD 4950\.00\/day/);
});

test('multi-provider summaries respect the UTF-8 budget and disclose omitted detail', () => {
  const report = fixture();
  const prototype = report.providers[0];
  report.summary = 'Observed evidence. '.repeat(1000);
  report.providers = Array.from({ length: 30 }, (_, index) => ({
    ...structuredClone(prototype), name: `provider-${index}`,
    coverage: Array(20).fill('\u754c'.repeat(1000)),
    gaps: Array(20).fill('\u754c'.repeat(1000)),
    resources: Array.from({ length: 10 }, (_, resourceIndex) => resource({
      id: `resource-${resourceIndex}`, dailyCost: null, currency: null, confidence: 'unknown',
    })),
  }));
  validateReport(report, report.providers.map((provider) => provider.name));
  for (const width of [60, 100, 110]) {
    const output = renderConsole(report, width);
    const content = output.split('\n').map((line) => line.replace(/^\| | \|$/g, '').trim()).join(' ');
    assert.ok(Buffer.byteLength(output, 'utf8') <= 12 * 1024);
    assert.match(output, /Resources: 300; priced: 0; unpriced: 300/);
    assert.match(output, /Console size limit reached/);
    assert.match(content, /provider\(s\) not shown/);
    assert.equal(output.split('\n').every((line) => !line || line.length === width), true);
  }
});

test('report validation rejects fabricated completeness, duplicates, invalid costs, and incomplete provider coverage', () => {
  const mutations = [
    (report) => { report.providers[0].resources[0].dailyCost = -1; },
    (report) => { report.providers[0].resources[0].dailyCost = Infinity; },
    (report) => { report.providers[0].resources[0].currency = null; },
    (report) => { report.providers[0].resources.push(resource()); },
    (report) => { report.providers[0].status = 'complete'; },
    (report) => { report.providers[0].name = 'azure'; },
    (report) => { report.providers[0].resources[0].source = ''; },
    (report) => { report.summary = '\u001b[2J'; },
    (report) => { report.generatedAt = '2026-02-30T00:00:00Z'; },
  ];
  for (const mutate of mutations) {
    const report = fixture();
    mutate(report);
    assert.throws(() => validateReport(report, ['aws']), /Invalid report/);
  }
  assert.throws(() => validateReport(fixture(), ['aws', 'azure']), /every selected provider/);
  for (const mutate of [
    (data) => { data.daily[0].date = '2026-02-30'; },
    (data) => { data.daily[0].date = '2026-11-15'; },
    (data) => { data.daily[0].date = '2026-11-16'; },
    (data) => { data.daily[0].complete = 'true'; },
    (data) => { data.daily.push({ ...data.daily[0] }); },
  ]) {
    const report = fixture();
    report.providers[0].spend = spend();
    mutate(report.providers[0].spend);
    assert.throws(() => validateReport(report, ['aws']), /Invalid report/);
  }
});

test('Markdown is opt-in, timestamped in UTC, and never overwrites a report', async (t) => {
  const root = await temporaryRoot(t);
  const report = fixture();
  const request = { providers: ['aws'], outputMd: false };
  const options = { root, now: new Date('2026-11-15T20:00:01Z'), columns: 80 };
  const defaultResult = await publishReport(report, request, options);
  assert.equal(defaultResult.outputPath, null);
  assert.equal(defaultResult.exitCode, 2);
  assert.deepEqual(await readdir(root), []);
  request.outputMd = true;
  const result = await publishReport(report, request, options);
  assert.equal(result.outputPath, join(root, 'outputs', '2026-11-15-20-00-01', 'report.md'));
  assert.match(await readFile(result.outputPath, 'utf8'), /# Cost Sweeper/);
  await assert.rejects(publishReport(report, request, options), /never overwritten/);
  const invalid = fixture();
  invalid.providers = [];
  await assert.rejects(publishReport(invalid, request, { root, now: new Date('2026-11-15T20:00:02Z') }));
  assert.deepEqual(await readdir(join(root, 'outputs')), ['2026-11-15-20-00-01']);
});

test('complete and failed provider reports have distinct exit codes and retain errors', async (t) => {
  const root = await temporaryRoot(t);
  const report = fixture();
  report.providers[0].spend = spend();
  report.providers[0].status = 'complete';
  report.providers[0].gaps = [];
  assert.equal((await publishReport(report, { providers: ['aws'], outputMd: false }, { root })).exitCode, 0);
  const provider = report.providers[0];
  provider.status = 'failed';
  provider.coverage = [];
  provider.spend = null;
  provider.resources = [];
  provider.errors = ['Credentials denied: configure read access'];
  const result = await publishReport(report, { providers: ['aws'], outputMd: false }, { root });
  assert.equal(result.exitCode, 2);
  assert.match(result.consoleText, /ERROR: Credentials denied/);
});

test('stdin CLI renders boxes and rejects invalid JSON without echoing submitted data', () => {
  const script = join(projectRoot, 'scripts', 'cost-sweep.mjs');
  const result = spawnSync(process.execPath, [script, 'report', 'aws'], {
    input: JSON.stringify(fixture()), encoding: 'utf8', cwd: projectRoot,
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^\+-+\+/);
  const invalid = spawnSync(process.execPath, [script, 'report', 'aws'], {
    input: '{private-credential-placeholder', encoding: 'utf8', cwd: projectRoot,
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /valid JSON object/);
  assert.equal(invalid.stderr.includes('private-credential-placeholder'), false);
});
