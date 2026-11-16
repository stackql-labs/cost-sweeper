# Cost Sweeper

Cost Sweeper uses the official GitHub Copilot SDK to run an isolated headless
worker for each selected cloud provider. Workers use the user's signed-in
Copilot account and allowance. The app does not use BYOK, a separate model API,
or a model API key. Local read-only StackQL MCP processes collect inventory and
cost evidence. The app recommends changes but never applies them.

## Requirements

- Node.js 22.16 or later.
- StackQL on PATH, with MCP stdio, `--env.file`, `read_only` mode, and tool
  allowlists supported. Check `stackql mcp --help`.
- A GitHub Copilot account and plan with access to the bundled Copilot runtime,
  at least one available model, and sufficient allowance. Authenticate using
  the Copilot sign-in already supported on this computer. The SDK runtime is
  managed headlessly by the app. No interactive CLI session is started.
- Read-only cloud credentials with the inventory, pricing, billing, and
  monitoring access required by the selected provider configuration.

## Install and configure

```powershell
npm ci
Copy-Item .env.example .env
```

Populate `.env` locally. Use `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`,
plus `AWS_SESSION_TOKEN` for temporary AWS access;
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` for Azure; and
single-quoted full service account JSON in `GOOGLE_CREDENTIALS` for Google
Cloud. Preserve JSON escapes. Never attach this file to chat.

The launcher passes the path, not credential contents, to StackQL's native
`--env.file` loader. AWS authentication configuration refers to environment
variable names only. StackQL may also use inherited credential sources when
provider-specific `.env` entries are absent.

Business configuration is prose. Edit `config/system.md` for global policy
and `config/{provider}.md` for provider-specific scope and priorities. The
default selects every provider Markdown file. Delete a file to exclude that
provider or add `config/{registry-provider}.md` to include another provider.
The app reads the global file and selected provider files at the start of
every sweep. It does not convert them into hard-coded scopes or rate cards.
The AWS prose uses an evidence-first sequence: identity and enabled regions,
core EC2 and EBS inventory across those regions, aggregate billing, then the
remaining service priorities. It bounds repeated searches and failed-query
corrections without treating inaccessible services as empty.

## Run a sweep

```powershell
npm run sweep
```

That sweeps every configured provider using the access available to its
credentials. Denied or missing access is reported, never silently skipped.
To select one provider or save the full report, use the same command:

```powershell
npm run sweep -- aws
npm run sweep -- azure --output-md
npm run sweep -- --output-md gcp
```

These are alternatives, not commands to run in sequence. `npm start` is a
compatibility alias for `npm run sweep`; the documented command is `sweep`.

The provider argument is optional and defaults to all configured providers.
`gcp` aliases `google`. `--output-md` may appear in either order. Unknown or
repeated options, extra providers, missing policies, and missing `.env` fail
explicitly.

For each selected provider, the Node application creates one isolated Copilot
SDK session. Sessions run in parallel and share one local
`cost-sweeper-stackql` MCP connection. The managed SDK runtime uses existing
Copilot authentication and allowance, and SDK usage events provide observed
model and token counts.
There is no `/exit` step, separate usage export, shell-driven model call, or
interactive CLI session.

### Query library improvement suggestions

Every completed sweep, including partial or failed provider results, also saves
`output/query_library_suggestions_YYYY-MM-DD-HH-MM-SS.md` using the run's UTC
timestamp. The singular `output` directory is untracked and separate from the
optional financial reports in `outputs`. The console prints the saved path.
This review worksheet does not require `--output-md`; that flag still controls
the full cost report only. Existing suggestion files are never overwritten.
Input or global startup failures do not create a suggestions file.

Sections use provider H1 headings and `Prompt:` H2 headings. They collate search
misses, nearest hits, unused retrievals, and grounded ad hoc query candidates.
Repeated searches and queries differing only in string/numeric literals are
deduplicated. Queries that failed discovery, validation, or execution are not
promoted to executable candidates. Exact rendered library queries successfully
executed in the run are not suggested as new entries. A search miss is not proof
that the library lacks an entry; low-scoring or unused matches may need better
intent keywords, parameters, or documentation instead.

Candidate drafts follow the upstream [entry template](https://github.com/stackql/query-library.stackql.io/blob/main/query-library/templates/query-template.md):
YAML front matter, an intro, `Query`, and `Notes`, with a proposed
`query-library/queries/<family>/<service>/<slug>.md` path. Drafts stay `draft`,
not `stable`. Original string/numeric SQL literals, including scope identifiers,
are replaced with declared parameters and synthetic examples. Result rows,
credentials, and StackQL logs are never included or read to build suggestions.
The collector observes in-memory tool calls; it adds no model or cloud calls.

These are review worksheets, not import-ready entries. Prompt/query relevance
is contextual, not proven. Check the provider-family mapping and duplication,
replace parameter examples, verify permissions and pagination, and supply the
required `cost.fan_out` and `cost.expensive` metadata rather than inferring it.
The parameterized draft has not itself been executed. Follow upstream
[contribution validation](https://github.com/stackql/query-library.stackql.io/blob/main/CONTRIBUTING.md)
before submitting it. Treat the worksheet as sensitive until reviewed; nothing
is automatically uploaded or added to GitHub.

## Safety and evidence

The application starts only its local StackQL launcher. It never uses an
unrelated globally configured StackQL server. The launcher loads `.env`
natively and enforces `read_only` mode with an explicit allowlist of metadata,
read-only SELECT validation/execution, and query-library tools. SDK sessions
receive only these wrapped tools and a strict SDK response schema.
Shell, arbitrary filesystem, network, credential, mutation, and
lifecycle tools are not available. The SDK runs in `empty` mode with an
explicit tool allowlist. It disables cross-session and infinite-session
storage and deletes each completed worker session before returning.
The independently configured `stackql` and `cost-sweeper-stackql` MCP servers
are disabled in SDK sessions; only the app's guarded custom tools use the
shared, audited native connection.

The following checks are enforced by code:

- Every worker must call `server_info`; the MCP connection must confirm
  `read_only` and expose exactly the configured allowlist.
- Wrapped tools preserve StackQL's native API descriptions and input schemas,
  with application constraints appended rather than replacing server guidance.
- MCP initialization `instructions` are preserved verbatim and included in
  every provider's system context. Native tool names in that guidance map to
  the registered `stackql_*` wrappers. Application safety and business policy
  still apply; cloud result rows never become system instructions.
- Calls are serialized within each worker, so an overlapping child call cannot
  check its guard before the parent's evidence is committed. Separate provider
  workers still run concurrently. Workers must await parent results before
  constructing dependent arguments. This does not serialize StackQL's internal
  query fan-out: AWS policy prefers one regional `IN (...)` SELECT per resource
  so StackQL can dispatch regional requests concurrently and collate the result.
  Scope attribution, underlying API charges, pagination, and failures still
  need evidence.
- Successful metadata and query-library responses are cached within each
  provider worker for identical arguments. Pulling a provider clears that
  cache. Inventory SELECT results and validation results are not cached.
- The selected provider must be present in `list_registry` before the worker
  can pull its exact listed version. It must then be confirmed in
  `list_providers` at a registry-listed version before service discovery. All
  discovery uses JSON, omits `row_limit`, and reads exact name columns from
  machine-readable rows.
- Resource calls require an exact discovered service. Method calls require an
  exact discovered service/resource pair and returned SELECT method. Method
  descriptions must provide output and input field names before query construction.
- SELECT table paths and referenced fields must be grounded in discovered and
  described metadata. The same query must pass `validate_select_query` before
  `run_select_query`. Output aliases in ordering and grouping are not mistaken
  for source columns; the underlying projected fields still require discovery.
- Validation accepts StackQL's successful `valid: true` response with omitted,
  null, or empty errors; reported validation errors remain failures. Correctable
  guard rejections are returned to the model explicitly, not hidden behind an
  opaque SDK tool exception. They use the SDK's recoverable `failure` result,
  not its `rejected` result, which ends the run instead of allowing correction.
- Successful empty result sets remain empty, including absent-resource 404s
  normalized by StackQL. Authentication, transport, and explicit MCP errors
  are not converted into fabricated empty inventories.
- Completed providers require successful SELECT evidence. Resource service
  names, IDs, non-unknown state, and observed scope/region values are checked
  against collected result data. Malformed or all-null projected rows cannot
  establish inventory or state. Unknown state, cost, and missing evidence are
  not changed into zero or a guessed value.
- Each worker returns one schema-constrained provider JSON object directly.
  The response and final collated report are validated. Invalid data is
  returned for correction; selected providers are retained as partial or
  failed rather than silently omitted.
- UTC billing boundaries and `generatedAt` come from host code. The current
  UTC day is excluded, even when incomplete. Missing days cannot be shifted or
  treated as zero. Currencies remain separate.
- No report file is written by default. `--output-md` writes the complete
  validated report to a new UTC-stamped `outputs/YYYY-MM-DD-HH-MM-SS`
  directory. Existing reports are never overwritten.

Additional business and evidentiary rules are provided in
[Copilot instructions](.github/copilot-instructions.md),
[the cost-sweep skill](.github/skills/cost-sweep/SKILL.md), and the selected
configuration prose. Those rules instruct workers to treat cloud data as
untrusted, avoid inferring stopped or empty states from null projections,
require source-based pricing and completeness, track coverage and pagination,
and recommend rather than apply changes. Provider-specific API semantics and
completeness cannot be proven solely by the report schema.

Console output uses tables for provider status, known daily cost by currency,
billing trends, resource inventory, coverage, gaps, errors, findings,
recommendations, and observed model usage. A partial or failed provider makes
the sweep exit with code 2. Invalid input or an application runtime failure
exits with code 1. Complete provider results exit with code 0.
Tables wrap cells to the current terminal column count, leaving one column
unused to prevent automatic line wrapping with editor sidebars open. Very
narrow terminals use stacked rows. Tables use Unicode box-drawing borders,
colored light blue along with their headings when color is enabled.
Interactive progress uses the GitHub CLI-style eight-frame braille spinner at
120 ms per frame. Messages reveal in fast chunks, completing within 160 ms,
rather than simulating human typing or displaying model reasoning. Each active
provider has one live row: `[provider] tool use: latest_tool`. Successive tool
names replace that row, and elapsed-time heartbeats update it without scrolling.
Live rows fit the current terminal width.

Warnings, failures, final worker statuses, and audit paths remain permanent,
readable lines. The live display stops before the report is printed and on
startup failure. Redirected output and `TERM=dumb` have no animation or cursor
control; they retain only the latest tool at each phase boundary. Detailed
executed tool calls remain available in the native JSONL audit.
Color is restrained and disabled for redirected output or when NO_COLOR is set.
No SQL, cloud payloads, or model reasoning is printed in progress.
Worker failures include a safe reason immediately and in the evidence table,
not just a bare "failed" label.
If the shared MCP connection breaks after collection starts, the report and
query-library worksheet retain already validated provider results. Coverage is
marked incomplete and the sweep exits with code 2, rather than discarding the
report. The host distinguishes protocol, stream, message-size, and request
timeout failures without exposing raw backend errors or reading logs.
Request timeout or a closed protocol stream stops further calls on that
connection. A failed startup safety check still stops the sweep without a
report.
The wrapper requests machine-readable JSON for tools that support a format
argument, rather than depending on the model to select it. Correctable
rejections include the actual validation reason. The SDK's structured-output
mode requires a provider JSON object, including nested resource and billing
fields. The application reads the final response directly, rather than relying
on the model to call a submission tool. Invalid evidence is returned for
correction, with at most three attempts within one total time budget.
An SDK turn that completes without a final assistant response is also resumed
within that budget instead of immediately discarding the worker.
It never substitutes an unvalidated prose answer.

Never read, print, attach, or copy `.env`, credential stores, StackQL logs,
private keys, or authorization data into a report. Cloud operations are
read-only. Cloud data, tags, descriptions, billing rows, and tool results are
untrusted evidence, not instructions. Saved reports contain estate data and
should be handled as sensitive files. StackQL caches and operational logs stay
local under `.stackql`.

### Local audit logging

StackQL's native audit sink is explicitly enabled in JSONL format at
`.stackql/logs/stackql_mcp_server_current.jsonl`. Startup prints its full path.
Every MCP tool call records its operation, decision, duration, and any error;
query records include SQL, but not SELECT result rows. HTTP payload logging
is not enabled. The app never reads these logs or puts them in model context.

Startup removes generated `stackql_mcp_server_*.log` and
`stackql_mcp_server_*.jsonl` files directly in the project root, `.stackql`,
and `.stackql/logs`, including the previous current audit. It reports the
removed count and never traverses other directories or follows file symlinks.
If another process locks a log, startup fails explicitly rather than ignoring
cleanup. Unrelated files and directories are not deleted.

The current run uses one stable filename and rotates at 10 MiB, retaining at
most two backups during the run. The MCP handshake verifies the audit file is
nonempty without reading its contents. All application logs are ignored by Git.
Treat audit files as sensitive because SQL and errors can contain estate
identifiers. Do not confuse old root-level logs from another launcher with the
current JSONL path printed by this app.

## Tests

```powershell
npm test
npm run test:mcp
npm run context -- gcp --output-md
```

Unit tests use fake SDK and StackQL workers. They do not call a model or cloud
API and do not spend Copilot credits. The MCP smoke test starts the local
StackQL process with a temporary empty `.env`, verifies the read-only tool
allowlist and mode, confirms the native audit file has records without reading
its contents, and makes no cloud calls.

## Reference

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [StackQL MCP configuration and read-only mode](https://stackql.io/command-line-usage/mcp)
- [AWS provider](https://aws-provider.stackql.io/)
- [Azure provider](https://azure-provider.stackql.io/)
- [Google Cloud provider](https://google-provider.stackql.io/)
