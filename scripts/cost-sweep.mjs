import { resolveRequest } from './arguments.mjs';
import { publishReport } from './report.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  if (!['context', 'report'].includes(command)) {
    throw new Error('Usage: node scripts/cost-sweep.mjs <context|report> [provider] [--output-md]');
  }
  const request = await resolveRequest(args);
  if (command === 'context') {
    console.log(JSON.stringify(request, null, 2));
  } else {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) throw new Error('Report input exceeds 16 MiB. Reduce unnecessary payload fields.');
      chunks.push(chunk);
    }
    let report;
    try {
      report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error('Report stdin must contain one valid JSON object. See docs/report-format.md.');
    }
    const result = await publishReport(report, request, { columns: process.stdout.columns });
    console.log(result.consoleText);
    if (result.outputPath) console.log(`\nMarkdown report saved: ${result.outputPath}`);
    process.exitCode = result.exitCode;
  }
} catch (error) {
  console.error(`Cost Sweeper: ${error.message}`);
  process.exitCode = 1;
}
