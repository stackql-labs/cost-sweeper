import { mkdir, stat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot, runChild } from './runtime.mjs';

export const readOnlyTools = [
  'server_info', 'list_registry', 'list_providers', 'pull_provider',
  'list_services', 'list_resources', 'list_methods', 'describe_method',
  'query_library_search', 'query_library_get',
  'validate_select_query', 'run_select_query',
];

export async function resetServerLogs(root = projectRoot) {
  let deleted = 0;
  for (const directory of [root, join(root, '.stackql'), join(root, '.stackql', 'logs')]) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^stackql_mcp_server_[^\\/]+\.(?:log|jsonl)$/.test(entry.name)) continue;
      try {
        await unlink(join(directory, entry.name));
        deleted++;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new Error(`Could not remove generated MCP log ${entry.name} (${error.code}). Stop any other server using this project's logs before retrying.`);
      }
    }
  }
  return deleted;
}

export async function prepareServer(root = projectRoot) {
  const envFile = join(root, '.env');
  let info;
  try {
    info = await stat(envFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Missing local .env. Copy .env.example to .env and populate credentials before starting MCP.');
  }
  if (!info.isFile()) throw new Error('The local .env must be a regular file.');
  const cache = join(root, '.stackql');
  const auditPath = join(cache, 'logs', 'stackql_mcp_server_current.jsonl');
  await mkdir(join(cache, 'logs'), { recursive: true });
  return {
    command: 'stackql',
    auditPath,
    args: [
      'mcp',
      '--mcp.server.type=stdio',
      '--mcp.config', JSON.stringify({
        server: {
          transport: 'stdio', mode: 'read_only',
          audit: {
            disabled: false, format: 'jsonl', failure_mode: 'strict',
            file: { path: auditPath, max_size_mb: 10, max_backups: 2, max_age_days: 7 },
          },
        },
        enabled_tools: readOnlyTools,
      }),
      '--env.file', envFile,
      '--auth', JSON.stringify({
        aws: {
          type: 'aws_signing_v4',
          keyIDenvvar: 'AWS_ACCESS_KEY_ID',
          credentialsenvvar: 'AWS_SECRET_ACCESS_KEY',
        },
      }),
      '--approot', cache,
      '--mcp.log.format', 'jsonl',
      '--http.response.pageLimit=-1',
    ],
    options: { cwd: cache },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = await prepareServer();
    await resetServerLogs();
    process.exitCode = await runChild(server.command, server.args, server.options);
  } catch (error) {
    console.error(`StackQL MCP: ${error.message}`);
    process.exitCode = 1;
  }
}
