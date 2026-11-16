import { CopilotClient } from '@github/copilot-sdk';
import { performance } from 'node:perf_hooks';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { resolveSweepContext } from './context.mjs';
import { createProgressLogger, renderSweepTables } from './console.mjs';
import { publishReport } from './report.mjs';
import { connectStackQL, safeStackQLFailure } from './stackql-client.mjs';
import { prepareServer, resetServerLogs } from './stackql-mcp.mjs';
import { runProviderWorkers } from './sweep.mjs';
import { projectRoot } from './runtime.mjs';
import { publishQueryLibrarySuggestions } from './query-library-suggestions.mjs';

export function buildClientOptions({ environment = process.env, userHome = homedir() } = {}) {
  return {
    mode: 'empty',
    baseDirectory: environment.COPILOT_HOME || join(userHome, '.copilot'),
    workingDirectory: projectRoot,
    logLevel: 'error',
    useLoggedInUser: true,
  };
}

function reportSummary(providers) {
  const count = (status) => providers.filter((provider) => provider.status === status).length;
  return `Collected evidence from ${providers.length} isolated provider workers: ${count('complete')} complete, ${count('partial')} partial, ${count('failed')} failed. Daily estimates and billed spend remain separate by currency.`;
}

export async function executeSweep(args, {
  createClient = () => new CopilotClient(buildClientOptions()),
  openStackQL,
  onProgress = createProgressLogger(),
  writeOutput = (text) => console.log(text),
  now = new Date(),
  root = projectRoot,
} = {}) {
  const startedAt = performance.now();
  let report;
  let published;
  let usage;
  let suggestionsPath;
  let cleanupFailed = false;
  try {
    const context = await resolveSweepContext(args, root, now);
    onProgress({ status: 'starting', detail: `Providers: ${context.providers.join(', ')}; reading prose policies` });
    const server = await prepareServer(root);
    const deletedLogs = await resetServerLogs(root);
    onProgress({ status: 'logging', detail: `removed ${deletedLogs} previous generated MCP logs` });
    const client = createClient();
    let stackql;
    try {
      try {
        onProgress({ status: 'connecting', detail: 'starting headless Copilot runtime' });
        await client.start();
        onProgress({ status: 'ready', detail: 'Copilot runtime started' });
      } catch {
        throw new Error('Copilot SDK runtime failed to start. Confirm Copilot sign-in, model availability, and SDK installation.');
      }
      try {
        onProgress({ status: 'connecting', detail: 'checking local StackQL read-only tools' });
        stackql = await (openStackQL ? openStackQL() : connectStackQL(server));
        onProgress({ status: 'ready', detail: 'StackQL read-only connection verified' });
        onProgress({ status: 'logging', detail: `StackQL JSONL audit: ${server.auditPath}` });
      } catch {
        throw new Error('The local cost-sweeper-stackql MCP connection failed its read-only safety check. Check StackQL on PATH and restart the local MCP process.');
      }
      const workers = await runProviderWorkers(context, client, {
        openStackQL: async () => stackql,
        closeStackQL: false,
        onProgress,
      });
      if (stackql.failure) {
        const message = safeStackQLFailure(stackql.failure);
        onProgress({ status: 'warning', detail: `${message} Retaining validated provider evidence; coverage is incomplete.` });
        for (const provider of workers.providers) {
          if (provider.status === 'complete') provider.status = 'partial';
          provider.errors.push(message);
          provider.gaps.push('Collection was interrupted by a shared MCP connection failure. Unqueried scopes remain unknown.');
        }
      }
      if (workers.cleanupFailed) {
        throw new Error('A Copilot worker session could not be removed from local session storage. No aggregate report was published.');
      }
      usage = workers.usage;
      report = {
        generatedAt: context.generatedAt,
        summary: reportSummary(workers.providers),
        providers: workers.providers,
      };
      published = await publishReport(report, context, {
        root,
        now: new Date(context.generatedAt),
        columns: process.stdout.columns,
      });
      suggestionsPath = await publishQueryLibrarySuggestions(workers.queryLibrarySuggestions, context.generatedAt, root);
      onProgress({ status: 'rendering', detail: 'collating validated provider results' });
    } finally {
      try {
        await stackql?.close();
      } catch {
        cleanupFailed = true;
      }
      try {
        const failures = await client.stop();
        cleanupFailed ||= Array.isArray(failures) && failures.length > 0;
      } catch {
        cleanupFailed = true;
      }
    }
  } finally {
    onProgress.stop?.();
  }
  const elapsedMs = performance.now() - startedAt;
  if (!published || !usage || !report) throw new Error('The sweep runtime ended without a report.');
  if (cleanupFailed) console.error('Copilot SDK runtime shutdown did not complete cleanly.');
  writeOutput(renderSweepTables(report, usage, elapsedMs));
  if (published.outputPath) writeOutput(`Markdown report saved: ${published.outputPath}`);
  writeOutput(`Query library suggestions saved: ${suggestionsPath}`);
  return { exitCode: cleanupFailed ? 1 : published.exitCode, outputPath: published.outputPath, suggestionsPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await executeSweep(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`Cost Sweeper: ${error.message}`);
    process.exitCode = 1;
  }
}
