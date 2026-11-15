function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function machineData(response) {
  if (response.structuredContent !== undefined) return response.structuredContent;
  for (const item of response.content ?? []) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    try {
      return JSON.parse(item.text);
    } catch {}
  }
  return null;
}

function resultRows(response, field) {
  const data = machineData(response);
  if (!object(data) || !Array.isArray(data.rows)) {
    throw new Error('The metadata result did not contain a machine-readable rows array. Repeat discovery in format=json or report a coverage gap.');
  }
  for (const row of data.rows) {
    if (!object(row) || typeof row[field] !== 'string' || !row[field].trim()) {
      throw new Error(`The metadata rows did not contain exact ${field} names. Report a discovery gap instead of guessing.`);
    }
  }
  return data.rows;
}

function scalarValues(value, out = new Set()) {
  if (typeof value === 'string' && value.trim()) out.add(value);
  else if (typeof value === 'number' && Number.isFinite(value)) out.add(String(value));
  else if (Array.isArray(value)) value.forEach((item) => scalarValues(item, out));
  else if (object(value)) Object.values(value).forEach((item) => scalarValues(item, out));
  return out;
}

function schemaKey(schema, pattern) {
  const properties = schema?.properties;
  if (!object(properties)) return null;
  return Object.keys(properties).find((key) => pattern.test(key)) ?? null;
}

function argument(args, pattern, label) {
  if (!object(args)) throw new Error('Tool arguments must be a JSON object.');
  const key = Object.keys(args).find((name) => pattern.test(name));
  const value = key === undefined ? undefined : args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Use the discovered ${label} in its named argument.`);
  return value;
}

function resourceKey(service, resource) {
  return `${service.toLowerCase()}\0${resource.toLowerCase()}`;
}

function methodKey(service, resource, method) {
  return `${resourceKey(service, resource)}\0${method.toLowerCase()}`;
}

const sqlKeywords = new Set([
  'all', 'and', 'as', 'asc', 'between', 'by', 'case', 'cast', 'current_date',
  'current_timestamp', 'date', 'desc', 'distinct', 'else', 'end', 'false', 'from',
  'group', 'having', 'in', 'interval', 'is', 'join', 'like', 'limit', 'not', 'null',
  'on', 'or', 'order', 'over', 'partition', 'select', 'then', 'timestamp', 'true', 'when',
  'where', 'with',
]);

function projectionExpressions(query) {
  const withoutStrings = query.replace(/'(?:''|[^'])*'/g, ' ');
  const match = withoutStrings.match(/^\s*SELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\s+FROM\b/i);
  if (!match) throw new Error('Use a SELECT projection that can be checked against describe_method output fields.');
  const expressions = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < match[1].length; index += 1) {
    const character = match[1][index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      expressions.push(match[1].slice(start, index).trim());
      start = index + 1;
    }
    if (depth < 0) throw new Error('The SELECT projection has unbalanced parentheses.');
  }
  if (depth !== 0) throw new Error('The SELECT projection has unbalanced parentheses.');
  expressions.push(match[1].slice(start).trim());
  if (expressions.some((expression) => !expression)) throw new Error('The SELECT projection contains an empty field expression.');
  return expressions;
}

function referencedFields(expression, aliases) {
  const cleaned = expression
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(/\bAS\s+[a-zA-Z_][\w]*/gi, ' ');
  const identifiers = [];
  for (const match of cleaned.matchAll(/\b[a-zA-Z_][\w]*\b/g)) {
    const identifier = match[0];
    const lower = identifier.toLowerCase();
    const following = cleaned.slice(match.index + identifier.length).match(/^\s*(.)/)?.[1];
    if (aliases.has(lower) || sqlKeywords.has(lower) || following === '(') continue;
    identifiers.push(identifier);
  }
  return identifiers;
}

function queryAliases(query) {
  const aliases = new Set();
  for (const match of query.matchAll(/\b(?:FROM|JOIN)\s+[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){2}\s+AS\s+([a-zA-Z_][\w]*)/gi)) {
    aliases.add(match[1].toLowerCase());
  }
  return aliases;
}

function validateQueryFields(query, schemas) {
  const aliases = queryAliases(query);
  const describedOutputs = new Set(schemas.flatMap((item) => [...item.outputs].map((field) => field.toLowerCase())));
  const describedFields = new Set(schemas.flatMap((item) =>
    [...item.outputs, ...item.inputs].map((field) => field.toLowerCase())));
  const projections = projectionExpressions(query);
  let projectedField = false;
  for (const expression of projections) {
    const trimmed = expression.trim();
    if (trimmed === '*') {
      if (!describedOutputs.size) throw new Error('SELECT * requires described output fields.');
      projectedField = true;
      continue;
    }
    const aliasProjection = trimmed.match(/^([a-zA-Z_][\w]*)\.\*$/);
    if (aliasProjection) {
      if (!aliases.has(aliasProjection[1].toLowerCase()) || !describedOutputs.size) {
        throw new Error('Qualified SELECT * must use a discovered table alias and described output fields.');
      }
      projectedField = true;
      continue;
    }
    const fields = referencedFields(expression, aliases);
    if (!fields.length && /^COUNT\s*\(\s*\*\s*\)(?:\s+AS\s+[a-zA-Z_][\w]*)?$/i.test(trimmed)) {
      if (!describedOutputs.size) throw new Error('COUNT(*) requires described output fields.');
      projectedField = true;
      continue;
    }
    if (!fields.length) throw new Error('Every SELECT expression must use a described output field.');
    for (const field of fields) {
      if (!describedOutputs.has(field.toLowerCase())) {
        throw new Error(`SELECT field ${field} was not returned as an output by describe_method.`);
      }
      projectedField = true;
    }
  }
  const withoutTables = query
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(/\b(?:FROM|JOIN)\s+[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){2}/gi, ' ');
  for (const field of referencedFields(withoutTables, aliases)) {
    if (!describedFields.has(field.toLowerCase())) {
      throw new Error(`SQL field ${field} was not returned by describe_method for a discovered table.`);
    }
  }
  if (!projectedField) throw new Error('The SELECT projection has no described output fields.');
}

function requireJsonFormat(args, schema) {
  const key = schemaKey(schema, /format/i);
  if (!key || args?.[key] !== 'json') {
    throw new Error('Repeat the parent metadata listing with format=json before using its names.');
  }
  const rowLimit = schemaKey(schema, /row_limit/i);
  if (rowLimit && args[rowLimit] !== undefined) {
    throw new Error('Do not set row_limit on discovery. Inspect all parent rows before reporting a name absent.');
  }
}

function requireSelectedProvider(args, schema, provider) {
  const key = schemaKey(schema, /^provider$/i);
  if (key && args?.[key] !== provider) {
    throw new Error(`This worker may only inspect provider ${provider}.`);
  }
}

function queryTables(query) {
  if (typeof query !== 'string' || !/^\s*SELECT\b/i.test(query)
    || /;\s*\S|--|\/\*|\b(?:INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|CALL|EXEC)\b/i.test(query)) {
    throw new Error('Only one validated read-only SELECT query is allowed.');
  }
  const tables = [...query.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){2})\b/gi)]
    .map((match) => match[1].toLowerCase());
  if (!tables.length) throw new Error('Use fully qualified, discovered provider.service.resource names in the SELECT.');
  return tables;
}

export class GroundingGuard {
  constructor(provider) {
    this.provider = provider;
    this.serverVerified = false;
    this.registryInspected = false;
    this.registryVersions = new Map();
    this.providerDiscovered = false;
    this.services = new Set();
    this.resources = new Map();
    this.methods = new Map();
    this.describedFields = new Map();
    this.validatedQueries = new Set();
    this.executedQueries = new Set();
    this.observedValues = new Set();
    this.observedRows = [];
    this.selectExecutions = 0;
  }

  before(name, args, schema) {
    if (name === 'server_info') return;
    if (!this.serverVerified) throw new Error('Call server_info first and confirm read_only mode.');
    if (name === 'list_registry') {
      requireJsonFormat(args, schema);
      const providerKey = schemaKey(schema, /^provider$/i);
      if (providerKey && args[providerKey] !== undefined && args[providerKey] !== this.provider) {
        throw new Error(`This worker may only inspect registry metadata for provider ${this.provider}.`);
      }
      return;
    }
    if (name === 'pull_provider') {
      const selected = argument(args, /provider/i, 'provider');
      if (selected !== this.provider || !this.registryVersions.has(selected)) {
        throw new Error('Pull only the selected provider and exact version returned by list_registry.');
      }
      const version = argument(args, /version/i, 'provider version');
      if (!this.registryVersions.get(selected).has(version)) {
        throw new Error('Use an exact provider version returned by list_registry.');
      }
      return;
    }
    if (name === 'list_providers') {
      if (!this.registryInspected) throw new Error('Inspect list_registry before checking installed providers.');
      return;
    }
    if (name === 'list_services') {
      if (!this.providerDiscovered) throw new Error('Confirm the selected provider in list_providers before listing services.');
      const selected = argument(args, /provider/i, 'provider');
      if (selected !== this.provider) throw new Error(`This worker may only discover provider ${this.provider}.`);
      requireJsonFormat(args, schema);
      return;
    }
    if (name === 'list_resources') {
      const service = argument(args, /service/i, 'service');
      requireSelectedProvider(args, schema, this.provider);
      if (!this.services.has(service.toLowerCase())) throw new Error("List resources only for an exact service returned by this provider's list_services call.");
      requireJsonFormat(args, schema);
      return;
    }
    if (name === 'list_methods') {
      const service = argument(args, /service/i, 'service');
      const resource = argument(args, /resource/i, 'resource');
      requireSelectedProvider(args, schema, this.provider);
      if (!this.resources.has(resourceKey(service, resource))) {
        throw new Error('List methods only for an exact service/resource pair returned by list_resources.');
      }
      requireJsonFormat(args, schema);
      return;
    }
    if (name === 'describe_method') {
      const service = argument(args, /service/i, 'service');
      const resource = argument(args, /resource/i, 'resource');
      const method = argument(args, /method/i, 'method');
      requireSelectedProvider(args, schema, this.provider);
      if (!this.methods.has(methodKey(service, resource, method))) {
        throw new Error('Describe only an exact SELECT method returned for the discovered service/resource pair.');
      }
      requireJsonFormat(args, schema);
      return;
    }
    if (name === 'validate_select_query' || name === 'run_select_query') {
      const query = argument(args, /^(?:query|sql)$/i, 'SELECT query');
      const tables = queryTables(query);
      const schemas = [];
      for (const table of tables) {
        const [provider, service, resource] = table.split('.');
        const key = resourceKey(service, resource);
        const fields = this.describedFields.get(key);
        if (provider !== this.provider.toLowerCase() || !this.services.has(service) || !this.resources.has(key) || !fields) {
          throw new Error('Discover and describe every exact table in the query before validation or execution.');
        }
        schemas.push(fields);
      }
      validateQueryFields(query, schemas);
      if (name === 'run_select_query' && !this.validatedQueries.has(query)) {
        throw new Error('Validate this exact SELECT query successfully before executing it.');
      }
      return { query, tables };
    }
  }

  after(name, args, schema, response, context) {
    if (response.isError === true) return;
    if (name === 'server_info') {
      const text = (response.content ?? []).filter((item) => item?.type === 'text')
        .map((item) => item.text ?? '').join('\n');
      if (!/^mode:\s*read_only\s*$/m.test(text) || !/^is_read_only:\s*true\s*$/m.test(text)) {
        throw new Error('Stop: this StackQL connection did not confirm read_only mode.');
      }
      this.serverVerified = true;
      return;
    }
    if (name === 'list_registry') {
      const rows = resultRows(response, 'provider');
      this.registryVersions.clear();
      for (const row of rows) {
        const versions = typeof row.version === 'string' ? [row.version.trim()]
          : typeof row.versions === 'string' ? row.versions.split(',').map((version) => version.trim()) : [];
        if (!versions.length || versions.some((version) => !/^[a-zA-Z0-9._-]+$/.test(version))) {
          throw new Error('Registry metadata omitted a provider version. Do not guess a version.');
        }
        if (!this.registryVersions.has(row.provider)) this.registryVersions.set(row.provider, new Set());
        for (const version of versions) this.registryVersions.get(row.provider).add(version);
      }
      this.registryInspected = true;
      return;
    }
    if (name === 'pull_provider') return;
    if (name === 'list_providers') {
      const rows = resultRows(response, 'name');
      const versions = this.registryVersions.get(this.provider);
      this.providerDiscovered = Boolean(versions && rows.some((row) =>
        row.name === this.provider && typeof row.version === 'string' && versions.has(row.version)));
      if (this.providerDiscovered) this.observedValues.add(this.provider);
      return;
    }
    if (name === 'list_services') {
      const rows = resultRows(response, 'name');
      for (const row of rows) {
        this.services.add(row.name.toLowerCase());
        this.observedValues.add(row.name);
      }
      return;
    }
    if (name === 'list_resources') {
      const service = argument(args, /service/i, 'service');
      const rows = resultRows(response, 'name');
      for (const row of rows) {
        this.resources.set(resourceKey(service, row.name), true);
        this.observedValues.add(row.name);
      }
      return;
    }
    if (name === 'list_methods') {
      const service = argument(args, /service/i, 'service');
      const resource = argument(args, /resource/i, 'resource');
      const rows = resultRows(response, 'MethodName');
      for (const row of rows) {
        if (typeof row.SQLVerb === 'string' && row.SQLVerb.toUpperCase() === 'SELECT') {
          this.methods.set(methodKey(service, resource, row.MethodName), true);
        }
      }
      return;
    }
    if (name === 'describe_method') {
      const service = argument(args, /service/i, 'service');
      const resource = argument(args, /resource/i, 'resource');
      const method = argument(args, /method/i, 'method');
      const rows = resultRows(response, 'name');
      if (!rows.length) throw new Error(`The ${method} description contained no machine-readable contract.`);
      const outputs = new Set();
      const inputs = new Set();
      for (const row of rows) {
        if (row.param_type === 'output') outputs.add(row.name);
        else if (row.param_type === 'input_required' || row.param_type === 'input_optional') inputs.add(row.name);
        else throw new Error(`The ${method} description contained an unknown field category. Report a schema gap.`);
      }
      if (!outputs.size) throw new Error(`The ${method} description contained no output fields.`);
      const key = resourceKey(service, resource);
      const existing = this.describedFields.get(key) ?? { outputs: new Set(), inputs: new Set() };
      for (const field of outputs) existing.outputs.add(field);
      for (const field of inputs) existing.inputs.add(field);
      this.describedFields.set(key, existing);
      return;
    }
    if (name === 'validate_select_query') {
      const data = machineData(response);
      if (!object(data) || data.valid !== true
        || (data.errors !== undefined && data.errors !== null && (!Array.isArray(data.errors) || data.errors.length !== 0))) {
        throw new Error('StackQL rejected or could not verify this SELECT. Correct it using the discovered method contract.');
      }
      this.validatedQueries.add(context.query);
      return;
    }
    if (name === 'run_select_query') {
      const data = machineData(response);
      if (!object(data) || !Array.isArray(data.rows)) {
        throw new Error('The SELECT result did not contain a machine-readable rows array. Do not claim an empty inventory.');
      }
      const observedRows = data.rows.map((row) => {
        if (!object(row)) throw new Error('The SELECT result contains malformed rows. Do not infer inventory or state.');
        const values = new Set(Object.values(row).filter((value) =>
          (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value)))
          .map(String));
        if (!values.size) throw new Error('The SELECT result contains only null or empty projections. Re-query described fields or report a gap.');
        return { values, services: new Set(context.tables.map((table) => table.split('.')[1])) };
      });
      this.validatedQueries.delete(context.query);
      this.executedQueries.add(context.query);
      this.selectExecutions += 1;
      for (const row of observedRows) {
        for (const value of row.values) this.observedValues.add(value);
      }
      this.observedRows.push(...observedRows);
    }
    if (name === 'query_library_get' || name === 'query_library_search') {
      const data = machineData(response);
      if (data !== null) {
        for (const value of scalarValues(data)) this.observedValues.add(value);
      }
    }
  }

  validateProvider(providerResult) {
    if (providerResult.status === 'complete' && this.selectExecutions === 0) {
      throw new Error('Complete coverage requires at least one successfully validated and executed SELECT query.');
    }
    for (const [index, resource] of providerResult.resources.entries()) {
      if (!this.services.has(resource.service.toLowerCase())) {
        throw new Error(`resources[${index}].service was not discovered through list_resources.`);
      }
      const matchingRow = this.observedRows.some((row) =>
        row.services.has(resource.service.toLowerCase()) && row.values.has(resource.id));
      if (!matchingRow) {
        throw new Error(`resources[${index}].id was not observed in a successful SELECT result. Do not invent identifiers; report a gap.`);
      }
      if (resource.state !== 'unknown'
        && !this.observedRows.some((row) =>
          row.services.has(resource.service.toLowerCase()) && row.values.has(resource.id) && row.values.has(resource.state))) {
        throw new Error(`resources[${index}].state was not observed with that identifier. Use unknown for null or unobserved state.`);
      }
      if (resource.region !== 'global' && resource.region !== 'unknown' && !this.observedValues.has(resource.region)) {
        throw new Error(`resources[${index}].region was not present in collected evidence.`);
      }
      if (resource.scope !== 'unknown' && !this.observedValues.has(resource.scope)) {
        throw new Error(`resources[${index}].scope was not present in collected evidence.`);
      }
      if (providerResult.status === 'complete' && (resource.region === 'unknown' || resource.scope === 'unknown')) {
        throw new Error('Complete coverage cannot contain resources with unknown scope or region.');
      }
    }
    if (!providerResult.resources.length && providerResult.status === 'complete' && this.observedRows.length === 0) {
      throw new Error('An empty complete inventory requires nonempty, non-null SELECT evidence.');
    }
  }
}
