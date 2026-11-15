import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from './runtime.mjs';

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid report: ${message}`);
}

function text(value, field) {
  requireValue(typeof value === 'string' && value.trim().length > 0, `${field} must be nonempty text`);
  requireValue(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), `${field} contains control characters`);
}

function texts(value, field) {
  requireValue(Array.isArray(value), `${field} must be an array`);
  value.forEach((item, index) => text(item, `${field}[${index}]`));
}

function object(value, field) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${field} must be an object`);
}

function currency(value, field) {
  requireValue(typeof value === 'string' && /^[A-Z]{3}$/.test(value), `${field} must be a three-letter currency`);
}

function calendarDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function validateReport(report, selectedProviders) {
  object(report, 'report');
  text(report.generatedAt, 'generatedAt');
  requireValue(/^\d{4}-\d{2}-\d{2}T/.test(report.generatedAt) && report.generatedAt.endsWith('Z')
    && Number.isFinite(Date.parse(report.generatedAt))
    && calendarDate(report.generatedAt.slice(0, 10)), 'generatedAt must be a valid UTC ISO timestamp');
  text(report.summary, 'summary');
  requireValue(Array.isArray(report.providers), 'providers must be an array');
  const seen = new Set();
  const resourceKeys = new Set();
  for (const provider of report.providers) {
    object(provider, 'provider');
    text(provider.name, 'provider.name');
    requireValue(selectedProviders.includes(provider.name), `unexpected provider ${provider.name}`);
    requireValue(!seen.has(provider.name), `duplicate provider ${provider.name}`);
    seen.add(provider.name);
    requireValue(['complete', 'partial', 'failed'].includes(provider.status), `${provider.name}.status is invalid`);
    for (const field of ['coverage', 'gaps', 'errors', 'findings', 'recommendations']) {
      texts(provider[field], `${provider.name}.${field}`);
    }
    requireValue(provider.status === 'failed' || provider.coverage.length > 0, `${provider.name} needs coverage evidence`);
    requireValue(provider.status !== 'failed' || provider.errors.length > 0, `${provider.name} failure needs an error`);
    requireValue(provider.status !== 'partial' || provider.gaps.length + provider.errors.length > 0,
      `${provider.name} partial coverage needs a gap or error`);
    requireValue(provider.status !== 'complete' || provider.gaps.length + provider.errors.length === 0,
      `${provider.name} cannot be complete with gaps or errors`);
    requireValue(Array.isArray(provider.resources), `${provider.name}.resources must be an array`);
    for (const resource of provider.resources) {
      object(resource, 'resource');
      for (const field of ['id', 'service', 'scope', 'region', 'state', 'basis', 'source']) {
        text(resource[field], `${provider.name}.resource.${field}`);
      }
      texts(resource.assumptions, 'resource.assumptions');
      requireValue(['high', 'medium', 'low', 'unknown'].includes(resource.confidence), 'resource.confidence is invalid');
      requireValue(resource.dailyCost === null || (typeof resource.dailyCost === 'number'
        && Number.isFinite(resource.dailyCost) && resource.dailyCost >= 0), 'resource.dailyCost must be nonnegative or null');
      if (resource.dailyCost !== null || resource.currency !== null) currency(resource.currency, 'resource.currency');
      requireValue(resource.dailyCost !== null || provider.status !== 'complete',
        `${provider.name} has unpriced resources and cannot be complete`);
      const key = JSON.stringify([provider.name, resource.scope, resource.service, resource.region, resource.id]);
      requireValue(!resourceKeys.has(key), `duplicate resource ${resource.id}`);
      resourceKeys.add(key);
    }
    if (provider.spend === null) {
      requireValue(provider.status !== 'complete', `${provider.name} has no spending history and cannot be complete`);
    } else {
      object(provider.spend, `${provider.name}.spend`);
      text(provider.spend.source, 'spend.source');
      text(provider.spend.basis, 'spend.basis');
      requireValue(Array.isArray(provider.spend.daily) && provider.spend.daily.length > 0, 'spend.daily must be nonempty');
      const days = new Set();
      for (const day of provider.spend.daily) {
        object(day, 'spend.daily entry');
        requireValue(calendarDate(day.date), 'spend date must be a real YYYY-MM-DD date');
        requireValue(day.date < report.generatedAt.slice(0, 10), 'spend dates must precede the current UTC day');
        currency(day.currency, 'spend currency');
        requireValue(typeof day.amount === 'number' && Number.isFinite(day.amount), 'spend amount must be finite');
        requireValue(typeof day.complete === 'boolean', 'spend complete must be boolean');
        const key = `${day.date}:${day.currency}`;
        requireValue(!days.has(key), `duplicate spending date/currency ${key}`);
        days.add(key);
      }
    }
    requireValue(provider.status !== 'failed' || (provider.resources.length === 0 && provider.spend === null),
      `${provider.name} with collected data should be partial, not failed`);
    if (provider.status === 'complete') {
      for (const trend of spendingTrends(provider.spend, report.generatedAt)) {
        requireValue(trend.available, `${provider.name} lacks comparable complete billing days`);
      }
    }
  }
  requireValue(seen.size === selectedProviders.length, `include every selected provider: ${selectedProviders.join(', ')}`);
  return report;
}

export function costSubtotals(resources) {
  const totals = new Map();
  for (const resource of resources) {
    if (resource.dailyCost === null) continue;
    const amount = (totals.get(resource.currency) ?? 0) + resource.dailyCost;
    requireValue(Number.isFinite(amount), 'cost subtotal overflow');
    totals.set(resource.currency, amount);
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function spendingTrends(spend, generatedAt) {
  if (spend === null) return [];
  const currencies = [...new Set(spend.daily.map((day) => day.currency))].sort();
  const midnight = Date.parse(`${generatedAt.slice(0, 10)}T00:00:00Z`);
  return currencies.map((unit) => {
    const amounts = new Map(spend.daily.filter((day) => day.currency === unit && day.complete)
      .map((day) => [day.date, day.amount]));
    const previous = [];
    const recent = [];
    for (let offset = 14; offset >= 1; offset--) {
      const date = new Date(midnight - offset * 86400000).toISOString().slice(0, 10);
      if (!amounts.has(date)) return { currency: unit, available: false };
      (offset > 7 ? previous : recent).push(amounts.get(date));
    }
    const previousDaily = previous.reduce((a, b) => a + b, 0) / 7;
    const recentDaily = recent.reduce((a, b) => a + b, 0) / 7;
    requireValue(Number.isFinite(previousDaily) && Number.isFinite(recentDaily), 'billing trend overflow');
    const deltaDaily = recentDaily - previousDaily;
    const percent = previousDaily > 0 ? deltaDaily / previousDaily * 100 : (recentDaily === 0 && previousDaily === 0 ? 0 : null);
    requireValue(Number.isFinite(deltaDaily) && (percent === null || Number.isFinite(percent)), 'billing change overflow');
    return { currency: unit, available: true, previousDaily, recentDaily, deltaDaily, percent };
  });
}

const clean = (value) => String(value).replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
const money = (amount, unit) => `${unit} ${amount.toFixed(2)}`;
const subtotalText = (resources) => costSubtotals(resources).map(([unit, total]) => `${money(total, unit)}/day`).join(' | ') || 'No priced subtotal available';

function overview(report) {
  const resources = report.providers.flatMap((provider) => provider.resources);
  return [
    `Generated: ${report.generatedAt}`,
    report.summary,
    `Provider coverage: ${report.providers.map((provider) => `${provider.name} (${provider.status})`).join(', ')}`,
    `Coverage totals: ${report.providers.filter((provider) => provider.status === 'complete').length} complete; ${report.providers.filter((provider) => provider.status === 'partial').length} partial; ${report.providers.filter((provider) => provider.status === 'failed').length} failed; ${report.providers.reduce((total, provider) => total + provider.gaps.length, 0)} gaps; ${report.providers.reduce((total, provider) => total + provider.errors.length, 0)} errors.`,
    `Known-cost subtotal: ${subtotalText(resources)}`,
    `Resources: ${resources.length}; priced: ${resources.filter((resource) => resource.dailyCost !== null).length}; unpriced: ${resources.filter((resource) => resource.dailyCost === null).length}`,
    'Current estimates are not historical billed spend. Unknowns and partial estimates are excluded or qualified; currencies are never combined.',
  ];
}

function trendLines(provider, generatedAt, includeDaily = true) {
  if (provider.spend === null) return ['Actual billed spend: unavailable. See gaps/errors.'];
  const lines = [`Actual billed spend source: ${provider.spend.source}`, `Billing basis: ${provider.spend.basis}`];
  for (const trend of spendingTrends(provider.spend, generatedAt)) {
    if (!trend.available) {
      lines.push(`${trend.currency}: trend unavailable; the preceding 14 UTC days are not all complete.`);
    } else {
      lines.push(`${trend.currency}: prior 7-day mean ${trend.previousDaily.toFixed(2)}/day; recent 7-day mean ${trend.recentDaily.toFixed(2)}/day; change ${trend.deltaDaily.toFixed(2)}/day (${trend.percent === null ? 'percentage unavailable: nonpositive baseline' : `${trend.percent.toFixed(1)}%`}).`);
    }
  }
  if (includeDaily) {
    for (const day of [...provider.spend.daily].sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency))) {
      lines.push(`${day.date}: ${money(day.amount, day.currency)}${day.complete ? '' : ' (incomplete, excluded from trends)'}`);
    }
  }
  return lines;
}

function resourceLines(resource) {
  return [
    `${resource.service} | ${resource.id}`,
    `Scope: ${resource.scope} | Region: ${resource.region} | State: ${resource.state}`,
    `Estimated daily cost: ${resource.dailyCost === null ? 'UNKNOWN' : money(resource.dailyCost, resource.currency)} | Confidence: ${resource.confidence}`,
    `Basis: ${resource.basis}`,
    `Source: ${resource.source}`,
    ...resource.assumptions.map((assumption) => `Assumption: ${assumption}`),
  ];
}

function sortedResources(resources) {
  return [...resources].sort((a, b) => (a.currency ?? '~').localeCompare(b.currency ?? '~')
    || (b.dailyCost ?? -1) - (a.dailyCost ?? -1) || a.id.localeCompare(b.id));
}

function wrap(value, width) {
  const words = clean(value).split(' ');
  const lines = [];
  let line = '';
  for (let word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = '';
    }
    while (word.length > width) {
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (word) line += `${line ? ' ' : ''}${word}`;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

export function box(title, lines, width) {
  const inner = width - 4;
  const border = `+${'-'.repeat(width - 2)}+`;
  const row = (line) => `| ${line.padEnd(inner)} |`;
  return [border, ...wrap(title.toUpperCase(), inner).map(row), border,
    ...lines.flatMap((line) => wrap(line, inner)).map(row), border].join('\n');
}

export function renderConsole(report, columns = 100) {
  const width = Math.min(110, Math.max(60, Number.isFinite(columns) ? Math.floor(columns) : 100));
  const brief = (value, limit = 200) => {
    const characters = [...clean(value)];
    return characters.length <= limit ? characters.join('') : `${characters.slice(0, limit).join('')} ... [shortened]`;
  };
  const items = (label, values) => [
    ...values.slice(0, 3).map((value) => `${label}: ${brief(value)}`),
    ...(values.length > 3 ? [`${label}: ${values.length - 3} additional items not shown.`] : []),
  ];
  const boxes = [box('Cost Sweeper', overview(report).map((line) => brief(line, 400)), width)];
  let detailedProviders = 0;
  const footer = (omitted) => box('Report detail', [
    'Console summary only. Full inventory, cost formulas, sources, assumptions, and daily billing require --output-md.',
    ...(omitted ? [`Console size limit reached: detail for ${omitted} provider(s) not shown. Overall totals and resource counts include all providers.`] : []),
    'No report file is written unless --output-md is requested. Full evidence remains available to the renderer in memory.',
  ], width);
  const byteLimit = 12 * 1024 - 1;
  for (const provider of report.providers) {
    const resources = sortedResources(provider.resources);
    const providerBox = box(`${brief(provider.name)} - ${provider.status}`, [
      brief(`Known-cost subtotal: ${subtotalText(resources)}`),
      `Resources: ${resources.length}; unpriced: ${resources.filter((resource) => resource.dailyCost === null).length} (UNKNOWN, not zero).`,
      ...items('Coverage', provider.coverage),
      ...items('GAP', provider.gaps),
      ...items('ERROR', provider.errors),
      ...trendLines(provider, report.generatedAt, false).map((line) => brief(line)),
      ...(resources.length ? ['Leading resources (ranked within each currency):'] : ['No resources observed. Check coverage before interpreting this as an empty estate.']),
      ...resources.slice(0, 5).flatMap((resource) => [
        brief(`${resource.service} | ${resource.id}`),
        brief(`Scope: ${resource.scope} | Region: ${resource.region} | State: ${resource.state}`),
        `Estimated daily cost: ${resource.dailyCost === null ? 'UNKNOWN' : money(resource.dailyCost, resource.currency)} | Confidence: ${resource.confidence}`,
      ]),
      ...(resources.length > 5 ? [`${resources.length - 5} additional resources not shown; included in totals and counts.`] : []),
      ...items('Finding', provider.findings),
      ...items('Recommendation', provider.recommendations),
      ...(!provider.findings.length && !provider.recommendations.length ? ['No evidenced findings or recommendations.'] : []),
    ], width);
    if (Buffer.byteLength([...boxes, providerBox, footer(report.providers.length)].join('\n\n'), 'utf8') > byteLimit) break;
    boxes.push(providerBox);
    detailedProviders++;
  }
  boxes.push(footer(report.providers.length - detailedProviders));
  return boxes.join('\n\n');
}

const md = (value) => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_[\]{}|#])/g, '\\$1');

export function renderMarkdown(report) {
  const lines = ['# Cost Sweeper', '', ...overview(report).map((line) => md(line)), ''];
  for (const provider of report.providers) {
    lines.push(`## ${md(provider.name)} (${provider.status})`, '', `Known-cost subtotal: ${md(subtotalText(provider.resources))}`, '');
    for (const [title, items] of [
      ['Coverage', provider.coverage], ['Gaps', provider.gaps], ['Errors', provider.errors],
      ['Actual billed spend', trendLines(provider, report.generatedAt)],
    ]) {
      lines.push(`### ${title}`, '', ...(items.length ? items.map((item) => `- ${md(item)}`) : ['None reported.']), '');
    }
    lines.push('### Resource inventory', '');
    if (!provider.resources.length) lines.push('No resources observed. Check coverage before interpreting this as an empty estate.', '');
    for (const resource of sortedResources(provider.resources)) {
      lines.push(`#### ${md(resource.id)}`, '', ...resourceLines(resource).map((line) => `- ${md(line)}`), '');
    }
    for (const [title, items] of [['Findings', provider.findings], ['Recommendations', provider.recommendations]]) {
      lines.push(`### ${title}`, '', ...(items.length ? items.map((item) => `- ${md(item)}`) : ['No evidenced items.']), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function publishReport(report, request, { root = projectRoot, now = new Date(), columns } = {}) {
  validateReport(report, request.providers);
  const consoleText = renderConsole(report, columns);
  let outputPath = null;
  if (request.outputMd) {
    const markdown = renderMarkdown(report);
    const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const outputs = join(root, 'outputs');
    await mkdir(outputs, { recursive: true });
    const directory = join(outputs, timestamp);
    try {
      await mkdir(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`Output directory already exists: ${directory}. Retry in the next second; existing reports are never overwritten.`);
    }
    outputPath = join(directory, 'report.md');
    await writeFile(outputPath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  return {
    consoleText,
    outputPath,
    exitCode: report.providers.some((provider) => provider.status !== 'complete') ? 2 : 0,
  };
}
