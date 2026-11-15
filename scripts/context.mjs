import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRequest } from './arguments.mjs';
import { projectRoot } from './runtime.mjs';

export async function resolveSweepContext(args, root = projectRoot, now = new Date()) {
  const request = await resolveRequest(args, root);
  const generatedAt = now.toISOString();
  const endExclusive = generatedAt.slice(0, 10);
  const midnight = Date.parse(`${endExclusive}T00:00:00Z`);
  const daysBefore = (days) => new Date(midnight - days * 86400000).toISOString().slice(0, 10);
  const [systemPolicy, providerPolicies, reportContract] = await Promise.all([
    readFile(request.system, 'utf8'),
    Promise.all(request.providerFiles.map(async (file) => ({
      provider: file.provider,
      text: await readFile(file.path, 'utf8'),
    }))),
    readFile(join(root, 'docs', 'report-format.md'), 'utf8'),
  ]);
  return {
    providers: request.providers,
    outputMd: request.outputMd,
    generatedAt,
    billingWindow: {
      endExclusive,
      lastEligibleDate: daysBefore(1),
      preceding30DaysStart: daysBefore(30),
      previous7Days: { startInclusive: daysBefore(14), endExclusive: daysBefore(7) },
      recent7Days: { startInclusive: daysBefore(7), endExclusive },
      rule: 'Never submit the current UTC day. complete=true requires provider evidence that the past day is finalized, not merely elapsed. Never shift trend windows or invent missing days.',
    },
    systemPolicy,
    providerPolicies,
    reportContract,
  };
}
