import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from './runtime.mjs';

export async function resolveRequest(args, root = projectRoot) {
  const configDirectory = join(root, 'config');
  const entries = await readdir(configDirectory, { withFileTypes: true });
  const available = entries
    .filter((entry) => entry.isFile() && /^[a-z][a-z0-9_]*\.md$/.test(entry.name) && entry.name !== 'system.md')
    .map((entry) => entry.name.slice(0, -3))
    .sort();
  if (!available.length) throw new Error('No provider Markdown files found in config.');
  let provider;
  let outputMd = false;
  for (const arg of args) {
    if (arg === '--output-md' && !outputMd) outputMd = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown or repeated option: ${arg}`);
    else if (provider !== undefined) throw new Error('Supply at most one provider positional argument.');
    else provider = arg;
  }
  provider = provider === 'gcp' ? 'google' : (provider ?? 'all');
  if (provider !== 'all' && !available.includes(provider)) {
    throw new Error(`Unknown provider: ${provider}. Available: ${available.join(', ')}, all.`);
  }
  const providers = provider === 'all' ? available : [provider];
  const system = join(configDirectory, 'system.md');
  if (!(await readFile(system, 'utf8')).trim()) throw new Error('config/system.md is empty.');
  const providerFiles = providers.map((name) => ({ provider: name, path: join(configDirectory, `${name}.md`) }));
  for (const file of providerFiles) {
    if (!(await readFile(file.path, 'utf8')).trim()) throw new Error(`Provider configuration is empty: ${file.provider}.`);
  }
  return { providers, outputMd, system, providerFiles };
}
