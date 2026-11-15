import { costSubtotals, spendingTrends } from './report.mjs';

const clean = (value) => String(value ?? '')
  .replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/[\u2012\u2013\u2014\u2212]/g, '-')
  .replace(/\s+/g, ' ').trim();

const cellWidth = (character) => /\p{Mark}/u.test(character) ? 0
  : /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(character) ? 2 : 1;
export const visibleWidth = (value) => [...String(value).replace(/\x1b\[[0-9;]*m/g, '')]
  .reduce((size, character) => size + cellWidth(character), 0);
export const viewportWidth = (columns = process.stdout.columns) =>
  Math.max(20, Math.min(120, Number.isFinite(columns) ? Math.floor(columns) - 1 : 79));
const pad = (value, size) => value + ' '.repeat(Math.max(0, size - visibleWidth(value)));
const useColor = () => Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env);
const paint = (value, code, enabled) => enabled ? `\x1b[${code}m${value}\x1b[0m` : value;

function wrap(value, size) {
  const lines = [];
  let line = '';
  for (let word of clean(value).split(' ')) {
    if (line && visibleWidth(`${line} ${word}`) > size) {
      lines.push(line.trimEnd());
      line = '';
    }
    while (visibleWidth(word) > size) {
      let part = '';
      let count = 0;
      for (const character of word) {
        if (visibleWidth(part + character) > size) break;
        part += character;
        count += character.length;
      }
      lines.push(part);
      word = word.slice(count);
    }
    line += `${line ? ' ' : ''}${word}`;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

export function table(headers, rows, columns = process.stdout.columns, color = useColor()) {
  const maximum = viewportWidth(columns);
  const names = headers.map(clean);
  const data = rows.map((row) => names.map((_, index) => clean(row[index])));
  if (names.length * 7 + 1 > maximum) {
    return data.map((row, index) => box(`Row ${index + 1}`,
      names.map((name, field) => `${name}: ${row[field]}`), columns, color)).join('\n\n');
  }
  const widths = names.map((name, index) => Math.max(4, visibleWidth(name), ...data.map((row) => visibleWidth(row[index]))));
  while (widths.reduce((sum, width) => sum + width + 3, 1) > maximum) {
    const largest = widths.indexOf(Math.max(...widths));
    widths[largest]--;
  }
  const border = (left, middle, right) => paint(
    `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`, '96', color);
  const row = (cells, code) => {
    const wrapped = cells.map((value, index) => wrap(value, widths[index]));
    return Array.from({ length: Math.max(...wrapped.map((lines) => lines.length)) }, (_, line) =>
      `${paint('│', '96', color)} ${widths.map((width, index) =>
        paint(pad(wrapped[index][line] ?? '', width), code, color && Boolean(code))).join(` ${paint('│', '96', color)} `)} ${paint('│', '96', color)}`).join('\n');
  };
  return [border('┌', '┬', '┐'), row(names, '1;96'), border('├', '┼', '┤'), ...data.map((cells) => {
    const status = cells[0];
    const code = /\/ (failed|errors)$/.test(status) ? '31' : /\/ (partial|gaps)$/.test(status) ? '33'
      : /\/ complete$/.test(status) ? '32' : null;
    return row(cells, code);
  }), border('└', '┴', '┘')].join('\n');
}

export function box(title, lines, columns = process.stdout.columns, color = useColor()) {
  const width = viewportWidth(columns) - 4;
  const border = (left, right) => paint(`${left}${'─'.repeat(width + 2)}${right}`, '96', color);
  const rows = (value, code) => wrap(value, width).map((line) =>
    `${paint('│', '96', color)} ${paint(pad(line, width), code, color && Boolean(code))} ${paint('│', '96', color)}`);
  return [border('┌', '┐'), ...rows(title, '1;96'), border('├', '┤'),
    ...lines.flatMap((line) => rows(line)), border('└', '┘')].join('\n');
}

export function createProgressLogger({ stream = process.stdout, color = stream.isTTY && !('NO_COLOR' in process.env) } = {}) {
  const colors = { failed: 31, error: 31, partial: 33, warning: 33, complete: 32, ready: 32 };
  const terminal = Boolean(stream.isTTY) && process.env.TERM !== 'dumb';
  const frames = [...'⣾⣽⣻⢿⡿⣟⣯⣷'];
  const rows = new Map();
  const pending = new Map();
  let timer;
  let drawnRows = 0;
  let lastFrame = '';
  let cursorHidden = false;
  let stopped = false;
  const started = Date.now();

  const label = (event) => `[${clean(event.provider ?? 'sweep')}] ${event.status === 'tool' ? 'tool use' : clean(event.status)}`;
  const suffix = (event, detail = clean(event.detail)) =>
    [detail, event.elapsedSeconds === undefined ? '' : `${event.elapsedSeconds}s elapsed`].filter(Boolean).join(' | ');
  const message = (event, detail) => {
    const body = suffix(event, detail);
    return `${label(event)}${body ? `: ${body}` : ''}`;
  };
  const print = (event) => {
    const prefix = label(event);
    const lines = wrap(message(event), viewportWidth(stream.columns));
    stream.write(`${lines.map((line, index) => index === 0
      ? line.replace(prefix, paint(prefix, colors[event.status] ?? 96, color)) : line).join('\n')}\n`);
  };
  const clip = (value, size) => {
    if (visibleWidth(value) <= size) return value;
    let result = '';
    for (const character of value) {
      if (visibleWidth(result + character) > size - 3) break;
      result += character;
    }
    return `${result}...`;
  };
  const clear = () => {
    if (drawnRows) stream.write(`\x1b[${drawnRows}A\r\x1b[J`);
    drawnRows = 0;
    lastFrame = '';
  };
  const redraw = () => {
    if (stopped || !rows.size) return;
    const frame = frames[Math.floor((Date.now() - started) / 120) % frames.length];
    const lines = [...rows.values()].map((row) => {
      const characters = [...row.detail];
      const ticks = Math.floor((Date.now() - row.changedAt) / 16);
      const revealed = characters.slice(0, ticks * Math.max(3, Math.ceil(characters.length / 10))).join('');
      const line = clip(message(row, revealed), viewportWidth(stream.columns) - 2);
      return `${paint(frame, 96, color)} ${paint(line, colors[row.status] ?? 96, color)}`;
    });
    const output = lines.join('\n');
    if (output === lastFrame) return;
    clear();
    if (!cursorHidden) {
      stream.write('\x1b[?25l');
      cursorHidden = true;
    }
    stream.write(`${output}\n`);
    drawnRows = lines.length;
    lastFrame = output;
  };
  const flush = (key) => {
    const event = pending.get(key);
    if (event) print(event);
    pending.delete(key);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clear();
    for (const key of pending.keys()) flush(key);
    if (cursorHidden) stream.write('\x1b[?25h');
    stream.off?.('resize', redraw);
    process.off('exit', stop);
  };
  const logger = (event) => {
    if (stopped || event.status === 'tool-complete') return;
    const key = event.provider ?? 'sweep';
    if (!terminal) {
      if (event.status === 'tool') {
        pending.set(key, { ...event, detail: clean(event.detail) });
        return;
      }
      if (event.status === 'working' && pending.has(key)) return;
      flush(key);
      print(event);
      return;
    }
    if (['warning', 'error', 'failed', 'partial', 'complete', 'logging'].includes(event.status)) {
      clear();
      print(event);
      if (['error', 'failed', 'partial', 'complete'].includes(event.status)) rows.delete(key);
      redraw();
      if (!rows.size) { clearInterval(timer); timer = undefined; }
      return;
    }
    if (event.provider) rows.delete('sweep');
    const previous = rows.get(key);
    if (event.status === 'working' && previous) {
      previous.elapsedSeconds = event.elapsedSeconds;
    } else {
      const detail = clean(event.detail);
      rows.set(key, {
        ...event, detail,
        changedAt: previous?.detail === detail && previous.status === event.status ? previous.changedAt : Date.now(),
      });
    }
    redraw();
    timer ??= setInterval(redraw, 16);
    timer.unref?.();
  };
  logger.stop = stop;
  if (terminal) {
    stream.on?.('resize', redraw);
    process.once('exit', stop);
  }
  return logger;
}

const dailyTotals = (provider) => costSubtotals(provider.resources)
  .map(([currency, amount]) => `${currency} ${amount.toFixed(2)}/day`).join('; ') || 'Unavailable';

const trendSummary = (provider, generatedAt) => {
  const trends = spendingTrends(provider.spend, generatedAt);
  return trends.map((trend) => trend.available
    ? `${trend.currency} ${trend.percent === null ? 'percentage unavailable' : `${trend.percent.toFixed(1)}%`}`
    : `${trend.currency} unavailable`).join('; ') || 'Unavailable';
};

export function renderSweepTables(report, usage, elapsedMs, columns = process.stdout.columns, color = useColor()) {
  const showTable = (headers, rows) => table(headers, rows, columns, color);
  const showBox = (title, lines) => box(title, lines, columns, color);
  const count = (status) => report.providers.filter((provider) => provider.status === status).length;
  const resources = report.providers.flatMap((provider) => provider.resources.map((resource) => [
    `${provider.name} / ${resource.service} / ${resource.id}`,
    `${resource.scope} / ${resource.region} / ${resource.state}`,
    `${resource.dailyCost === null ? 'UNKNOWN' : `${resource.currency} ${resource.dailyCost.toFixed(2)}/day`}; confidence: ${resource.confidence}`,
  ]));
  const evidence = report.providers.flatMap((provider) => [
    ...['errors', 'gaps', 'findings', 'recommendations', 'coverage'].flatMap((field) =>
      provider[field].map((item) => [`${provider.name} / ${field}`, item])),
  ]);
  const showCount = (data, field) => data.incomplete ? 'unavailable' : data[field].toLocaleString('en-US');
  const models = [...usage.models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, data]) => [
    model,
    `Calls: ${data.calls}; Input: ${showCount(data, 'inputTokens')}; Output: ${showCount(data, 'outputTokens')}; Cache read: ${showCount(data, 'cacheReadTokens')}; Cache write: ${showCount(data, 'cacheWriteTokens')}`,
  ]);
  return [
    showBox('Cost Sweeper', [
      report.summary, `Generated at: ${report.generatedAt}`,
      `Provider workers: ${count('complete')} complete, ${count('partial')} partial, ${count('failed')} failed`,
      `Observed resources: ${resources.length}`,
      `Elapsed: ${(elapsedMs / 1000).toFixed(3)} seconds`,
      'Known daily estimates keep currencies separate. Unknown cost is not zero.',
    ]),
    showTable(['Provider / status', 'Resources', 'Known daily cost', '14-day trend'], report.providers.map((provider) =>
      [`${provider.name} / ${provider.status}`, provider.resources.length, dailyTotals(provider), trendSummary(provider, report.generatedAt)])),
    showTable(['Resource', 'Location / state', 'Daily estimate'], resources.length ? resources : [
      ['No validated resources reported', 'Check errors and coverage before interpreting this as an empty estate.', 'Unavailable'],
    ]),
    showTable(['Evidence', 'Details'], evidence.length ? evidence : [['Evidence', 'No evidence notes reported.']]),
    showBox('Copilot usage', [
      'Observed SDK usage. Cache counts are shown separately and included in input tokens.',
      ...(usage.invalidEvents ? [`Unavailable or invalid usage events: ${usage.invalidEvents}`] : []),
    ]),
    showTable(['Model', 'Usage'], models.length ? models : [['No usage events reported', 'Token counts unavailable']]),
  ].join('\n\n');
}
