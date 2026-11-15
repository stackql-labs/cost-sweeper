import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from './runtime.mjs';

function payload(response) {
  if (response?.structuredContent !== undefined) return response.structuredContent;
  for (const item of response?.content ?? []) {
    if (item?.type !== 'text') continue;
    try { return JSON.parse(item.text); } catch {}
  }
  return null;
}

const entryId = (value) => typeof value === 'string' && /^[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(value);
const text = (value) => String(value).replace(/[\u2013\u2014]/g, '-').replace(/[\r\n\t]+/g, ' ').trim();
const heading = (value) => text(value).replace(/[\\`*_{}[\]<>#]/g, '\\$&');

function fence(value, language) {
  const size = Math.max(3, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1));
  const marker = '`'.repeat(size);
  return `${marker}${language}\n${value}\n${marker}`;
}

export function parameterizeQuery(sql) {
  const params = [];
  const names = new Set();
  const template = sql.replace(/'(?:''|[^'])*'|(?<![a-zA-Z0-9_.-])-?\d+(?:\.\d+)?(?![a-zA-Z0-9_.-])/g, (literal, offset) => {
    const field = sql.slice(0, offset).match(/\b([a-z][a-z0-9_]*)\s*(?:=|>=|<=|>|<)\s*$/i)?.[1]?.toLowerCase();
    const base = field ?? `value_${params.length + 1}`;
    let name = base;
    for (let index = 2; names.has(name); index++) name = `${base}_${index}`;
    names.add(name);
    const string = literal.startsWith("'");
    params.push({
      name, type: string ? 'string' : 'number', required: true,
      description: `Review the value and constraints for ${name}.`,
      example: string ? 'replace_me' : 1,
    });
    return string ? `'{{${name}}}'` : `{{${name}}}`;
  });
  return { template, params };
}

export class QueryLibrarySuggestions {
  constructor(providers) {
    this.providers = new Map(providers.map((provider) => [provider, {
      searches: new Map(), queries: new Map(), rendered: new Map(),
    }]));
  }

  record(provider, operation, args, response, context) {
    const state = this.providers.get(provider);
    if (!state) throw new Error('Query library evidence belongs to an unselected provider.');
    if (operation === 'query_library_search') {
      if (typeof args.intent !== 'string' || !args.intent.trim()) return;
      const data = payload(response);
      const service = typeof args.service === 'string' ? args.service : null;
      const key = JSON.stringify([text(args.intent).toLowerCase(), service]);
      const previous = state.searches.get(key);
      state.searches.delete(key);
      state.searches.set(key, {
        prompt: text(args.intent), service, attempts: (previous?.attempts ?? 0) + 1,
        hits: Array.isArray(data?.hits) ? data.hits.map((hit) => hit?.id).filter(entryId) : [],
        miss: typeof data?.miss === 'boolean' ? data.miss : null,
        stale: data?.stale === true,
        failed: response === null,
      });
    }
    if (operation === 'query_library_get') {
      const data = payload(response);
      if (data?.valid === true && typeof data.sql === 'string' && entryId(data.id)) {
        state.rendered.set(data.sql.trim(), data.id);
      }
    }
    if (operation === 'run_select_query' && context?.query && context.tables?.length) {
      const services = [...new Set(context.tables.map((table) => table.split('.')[1]))];
      const search = [...state.searches.values()].reverse().find((item) => !item.service || services.includes(item.service));
      const query = parameterizeQuery(context.query);
      const key = query.template.trim();
      const previous = state.queries.get(key);
      state.queries.set(key, {
        ...query, services, prompt: search?.prompt ?? `List ${context.tables.join(', ')}`,
        sourceQueries: [...(previous?.sourceQueries ?? []), context.query.trim()],
        executions: (previous?.executions ?? 0) + 1,
      });
    }
  }

  render(generatedAt) {
    const lines = [
      `Generated at: ${generatedAt}`, '',
      'Review suggestions for [the StackQL query library](https://github.com/stackql/query-library.stackql.io).',
      'Search misses and unused hits are retrieval evidence, not proof that an entry is absent.',
      'SQL drafts come only from SELECTs accepted by the discovery guard, validated, and successfully executed.',
      'No result rows, original string/numeric SQL literal values, credentials, or logs are included.',
      'Drafts need relevance, duplication, parameter examples, permissions, and cost review before sharing or importing.', '',
    ];
    for (const [provider, state] of this.providers) {
      lines.push(`# ${heading(provider)}`, '');
      const groups = new Map();
      for (const search of state.searches.values()) {
        groups.set(search.prompt, { searches: [...(groups.get(search.prompt)?.searches ?? []), search], queries: [] });
      }
      for (const query of state.queries.values()) {
        if (query.sourceQueries.every((sql) => state.rendered.has(sql))) continue;
        if (!groups.has(query.prompt)) groups.set(query.prompt, { searches: [], queries: [] });
        groups.get(query.prompt).queries.push(query);
      }
      let count = 0;
      for (const [prompt, group] of groups) {
        const hits = [...new Set(group.searches.flatMap((search) => search.hits))];
        const used = hits.filter((id) => [...state.rendered.entries()].some(([sql, entry]) =>
          entry === id && [...state.queries.values()].some((query) => query.sourceQueries.includes(sql))));
        if (!group.queries.length && group.searches.every((search) => search.miss === false) && used.length) continue;
        count++;
        lines.push(`## Prompt: ${heading(prompt)}`, '', '### Retrieval evidence', '');
        for (const search of group.searches) {
          const outcome = search.failed ? 'Search failed; a catalogue gap is not established.'
            : search.miss === true ? 'The library reported a search miss (nearest hits may still exist).'
              : search.miss === false ? 'Hits returned; relevance and usability need review.'
                : 'The search response did not establish hit/miss status.';
          lines.push(`- ${outcome} Attempts: ${search.attempts}.`,
            ...(search.stale ? ['- The search used stale cached or snapshot content.'] : []));
        }
        if (hits.length) lines.push(`- Related entry IDs: ${hits.map((id) => `\`${id}\``).join(', ')}.`);
        if (used.length) lines.push(`- Successfully executed existing entries: ${used.map((id) => `\`${id}\``).join(', ')}.`);
        lines.push('');
        if (!group.queries.length) {
          lines.push('No new executable query was established. Review existing intent keywords or author and verify a query for this prompt; do not add guessed SQL.', '');
        }
        group.queries.forEach((query, index) => {
          const slug = text(prompt).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'observed-query';
          const path = `query-library/queries/${provider}/${query.services[0]}/${slug}${index ? `-${index + 1}` : ''}.md`;
          lines.push('### Proposed entry', '', `Suggested path (confirm the provider-family mapping): \`${path}\``, '',
            `Source SELECT validated and executed on ${generatedAt.slice(0, 10)}; ${query.executions} successful execution(s), including any empty result sets.`,
            'The parameterized draft has not been separately executed. Original literal values were removed.', '',
            '**Not ready for import:** required `cost.fan_out` and `cost.expensive` are intentionally not inferred. Add reviewed cost metadata and meaningful parameter examples before running upstream validation.', '');
          const metadata = {
            title: (text(prompt).length >= 5 ? text(prompt) : `Query ${text(prompt)}`).slice(0, 80),
            description: `Read-only query candidate for ${text(prompt)}. Review scope and parameters before reuse.`.slice(0, 300),
            verb: 'select', status: 'draft', providers: [provider], services: query.services,
            tags: [provider, query.services[0]],
            intent_keywords: [text(prompt).length >= 5 ? text(prompt) : `Query ${text(prompt)}`, `Show results for ${text(prompt)}`],
            params: query.params,
          };
          const frontMatter = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
          const entry = [
            '---', frontMatter, '# Add reviewed cost.fan_out and cost.expensive before importing.', '---', '',
            'Draft based on an observed read-only query. Review relevance, scope, pagination and parameter constraints.', '',
            '## Query', '', fence(query.template, 'sql'), '', '## Notes', '',
            'Original SQL literal values and result rows are not exported. Replace synthetic parameter examples, review cost and required permissions, and validate the rendered template before publishing.',
          ].join('\n');
          lines.push(fence(entry, 'markdown'), '');
        });
      }
      if (!count) lines.push('No unresolved library searches or new executed query candidates were observed.', '');
    }
    return `${lines.join('\n')}\n`;
  }
}

export async function publishQueryLibrarySuggestions(suggestions, generatedAt, root = projectRoot) {
  const directory = join(root, 'output');
  await mkdir(directory, { recursive: true });
  const timestamp = new Date(generatedAt).toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const path = join(directory, `query_library_suggestions_${timestamp}.md`);
  try {
    await writeFile(path, suggestions.render(generatedAt), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Query library suggestions already exist: ${path}. Retry in the next second; existing suggestions are never overwritten.`);
  }
  return path;
}
