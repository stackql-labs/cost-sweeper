# Cost management policy

Inventory all providers with a Markdown file alongside this file unless the
user supplies one provider as the positional argument. The provider file name
is its StackQL registry identifier: aws, azure, google, or another registry
provider added later. The optional argument all also means every provider.
The gcp positional alias selects google. Other unknown names are errors.

Use only the local stdio cost-sweeper-stackql MCP server, started by the client
through the project's launcher. It loads credentials from the project .env.
Never expose credentials to the model, console, or saved reports. Missing
credentials or denied permissions are coverage gaps, not empty inventories.
Use read-only cloud identities with inventory, billing, pricing, and monitoring
read permissions as appropriate. Do not acquire broader permissions.

Discover accessible account, subscription, project, region, and zone scopes.
Follow any explicit scope restrictions in the provider prose. Do not infer a
complete estate from one accessible account. Identify included and inaccessible
scopes, services inspected, pagination limits, and any other omissions.
Do not scan other tenants or organizations beyond the credential's authority.

For each provider, discover metadata and query-library examples before writing
SQL. Describe the actual resource and method, supply required parameters, and
validate SELECT queries before executing them. Never guess resource names,
columns, or pricing API support. Follow pagination until exhausted. If an API
or tool result is truncated, record incomplete coverage and narrow the query.
Batch queries by scope and service instead of making a model call per resource.
Cache metadata and pricing evidence within this sweep only. Avoid scanning
bucket objects, downloading payloads, or queries that incur substantial costs.

Inventory deployed billable compute, storage, databases, networking, managed
clusters, and other material services. Include stopped compute's persistent
storage, snapshots, reserved public IPs, and idle gateways where billable.
Deduplicate stable resource identities across overlapping list results.
Do not assign a parent's aggregate bill to each child resource.

Find daily actual billed spend for the last 30 complete UTC days where billing
APIs or existing exports allow it. Keep provider-reported currency, cost basis
(for example amortized or unblended), credits, tax treatment, and reporting lag
explicit. Compare the most recent seven complete days against the preceding
seven comparable days. Missing days are unknown, not zero. Exclude the current
partial day. Never substitute inventory estimates for historical billed spend.
Use the context tool's explicit UTC boundaries rather than local calendar dates.
The comparison windows are the two seven-day periods immediately preceding
the current UTC day; do not shift them to older finalized dates. An estimated
or missing day makes the comparison unavailable. A day having ended does not
prove its billing is finalized.
If historical data is unavailable, report this and still inventory resources.

Estimate current daily run rate using verified regional SKU pricing, 24-hour
runtime where appropriate, observed provisioned capacity, and observed usage
for metered charges. For a monthly price use 730 hours per month and 24 hours
per day; record that assumption. Use actual commitment or negotiated rates
only when observed. Cite pricing source, SKU, region, effective date, formula,
and whether taxes, discounts, support, transfer, or request charges are excluded.
If part of a resource's cost is unknown, the dailyCost may represent a known
component only if its basis and assumptions explicitly label it as partial.
Otherwise use null and state what information is missing. A zero estimate
requires positive evidence that the inspected resource is not currently billed.

Never combine currencies without an explicitly sourced conversion requested
by the user. Totals are known-cost subtotals, not complete estate bills.
Round only for display, not during aggregation. Explain why billing totals and
current inventory estimates differ.

Prioritize findings by evidenced daily impact. Flag week-over-week increases
of at least 20 percent and at least 5 currency units per day, and idle resources
only when utilization evidence supports the claim. Recommendations must cite
resource or billing evidence, assumptions, and operational risk. Do not claim
guaranteed savings or automate remediation.

Return a boxed console report by default, with scope coverage, priced subtotals,
unpriced counts, daily spending trends, resource-level estimates and their
evidence, recommendations, and failures. Use the supplied renderer. With
--output-md also save that same report in a new untracked
outputs/YYYY-MM-DD-HH-MM-SS directory, using UTC for the directory timestamp.
Do not save intermediate cloud data or a report without that flag.
The host also saves a separate, untracked query-library suggestions worksheet
for each completed run in output/query_library_suggestions_YYYY-MM-DD-HH-MM-SS.md.
Group it by provider and prompt. Use only in-memory retrieval evidence and
successfully validated and executed SELECTs, never logs or result rows.
Parameterize original SQL literal values and keep drafts explicitly subject to
cost, permissions, relevance, privacy, and upstream validation review. Do not
run extra cloud queries or publish to GitHub to produce these suggestions.

The application uses GitHub Copilot through the official Copilot SDK and its
managed headless runtime. It creates one isolated worker session per selected
provider using the signed-in Copilot account and allowance. Do not configure
BYOK or require a separate model API key. Copilot credit consumption is not
cloud-estate spend. Report model and token counts only from SDK usage events;
missing usage evidence is unavailable, not zero.
