import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectStackQL } from './stackql-client.mjs';
import { prepareServer } from './stackql-mcp.mjs';
import { projectRoot } from './runtime.mjs';

const cacheRoot = join(projectRoot, '.stackql');
const directory = join(cacheRoot, `mcp-check-${process.pid}-${randomUUID()}`);
let client;
try {
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(directory);
  await writeFile(join(directory, '.env'), '# Empty smoke-test credentials; no cloud API calls.\n');
  const server = await prepareServer(directory);
  client = await connectStackQL(server);
  if ((await stat(server.auditPath)).size === 0) throw new Error('The JSONL audit sink did not record the metadata handshake.');
  console.log(`StackQL stdio MCP ready: ${client.tools.size} allowlisted tools; read_only mode confirmed; no cloud queries performed.`);
} catch (error) {
  console.error(`MCP check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
}
