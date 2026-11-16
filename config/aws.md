# AWS estate

Use the aws registry provider. Credentials are the AWS_ACCESS_KEY_ID and
AWS_SECRET_ACCESS_KEY in .env, plus AWS_SESSION_TOKEN for temporary sessions.
An empty or invalid credential set is an explicit coverage failure.

## Execution strategy

Produce useful evidence early. Do not tour the whole AWS catalogue or search
the query library for every resource before executing inventory queries.
Complete identity, region discovery, and a small core inventory first, then
expand coverage with the evidence already collected. A useful partial report
is preferable to spending the entire run on metadata or repeatedly failing
secondary services.

Start with STS caller identity to establish the current account. Discover
enabled regions, then inspect each accessible region. Inspect additional
accounts only if the supplied identity already has an authorized access path;
do not invent cross-account access. Global services must not be counted once
per region. To restrict the sweep, replace this paragraph with the desired
account IDs and regions in ordinary prose.

For commercial AWS, if the described identity or region-discovery method
requires a bootstrap region, use us-east-1 only as its discovery endpoint.
This is not a restriction of the inventory scope. For another AWS partition,
use an evidenced endpoint in that partition or record the missing bootstrap
scope instead of guessing one.

List provider services once, select exact returned names, and reuse completed
resource, method, and field descriptions. Inspect EC2 instances and EBS volumes
across the discovered enabled regions before exploring secondary services in
depth. Finish discovery, validation, and execution for each selected resource
before opening another discovery branch. Do not repeat global-service
discovery or inventory once per region. Do not claim complete coverage until
the remaining priorities below have actually been inspected.

For regional inventory methods, prefer StackQL's native asynchronous fan-out:
use region IN (...) with the discovered enabled regions permitted by this
policy, then validate and execute that single SELECT. StackQL dispatches the
regional requests concurrently and collates their results within one execution
tool call. Do not issue a separate tool call for every region by default.
Reuse one described resource contract across that batch. Split it only when
timeouts, truncation, per-region failures, or missing attribution require a
narrower query, and record unresolved regions as coverage gaps.

One tool call still fans out to multiple cloud API calls; it does not remove
API charges, throttling, or pagination requirements. Preserve region
attribution from returned evidence. If a collated row does not identify its
region, do not assign it to the first region in the IN list. Use unknown
region and unknown region-dependent pricing, or a narrower query when that
attribution is needed.

Use one focused query-library search for a missing capability. Retrieve a
clearly relevant hit if present, but check every table, parameter, and output
against current discovery. A miss or unsuitable hit means construct a simple
SELECT from the described method, not keep rephrasing library searches.
Select only the described fields needed for resource identity, state,
capacity, and costing. Avoid large nested payloads and SELECT * when a small
projection suffices; retain pagination and never turn a limited page into a
complete inventory claim.

Prefer a discovered flat resource, one row per item, over unnesting nested
arrays from a summary resource. State, tags, and attachments may be JSON text:
inspect the observed shape and use JSON_EXTRACT on the described column when
needed. Do not confuse a JSON state object with a directly returned state name.
For billing, selecting the described JSON result column and reading its
observed groups is preferable to a complicated join or unnesting experiment.
Aim to get a newly selected resource into inventory within about ten tool
calls, including its discovery. Prefer a regional fan-out batch using that
contract rather than repeating the sequence for later regions.

Input parameters are filters, not necessarily output columns. In particular,
do not project region or bucket_region unless the exact method describes it
as an output. Use an independently observed region as report scope when the
inventory method does not return it. Inspect the exact table before using a
query-library template; a template does not establish discovered metadata.

Correct a query rejection once using its described contract. If it still
fails, record the exact service, resource, region, and safe reason as a gap,
then continue a different useful scope. Do not loop over failing snapshot,
address, ECS, or database-cluster methods or invent alternative names.
A metadata error is not an empty estate. If the host reports a broken MCP
connection, stop tool calls and finalize the evidence already collected.

## Inventory and costs

Prioritize EC2 instances, EBS volumes and snapshots, S3 bucket-level storage
metrics, RDS and Aurora, ECS and EKS capacity, Lambda usage, load balancers,
NAT gateways, public IPv4 addresses, ElastiCache, and OpenSearch. Managed
clusters and their backing instances must not double count compute charges.
Stopped instances do not incur compute runtime charges but attached storage
and other billable dependencies remain in scope. S3 bucket existence alone
does not establish stored bytes or request cost.

Discover Cost Explorer metadata and available read methods for daily actual
spend. Use the last 30 complete UTC days, consistent unblended or amortized
cost, and document the choice. Billing access may require management or payer
account permissions. Do not equate denied access with zero spend. Avoid
per-resource billing calls, which may have additional charges; use aggregated
daily queries when available. Use pricing APIs or verified rate evidence
accessible via StackQL for the observed instance types, storage classes,
database engines, and regional SKUs. Cost Explorer aggregate daily spend is
not a per-resource current estimate.

After the core inventory, attempt one grounded aggregate Cost Explorer daily
spend query before a long tail of secondary inventory. If billing is
unavailable, retain the resource inventory with unknown costs and its
explicit billing gap. Do not exhaust the run hunting prices for unobserved
resources or wait for every price to be known before returning resources.
In commercial AWS, Cost Explorer uses the global billing endpoint in
us-east-1, not one billing call per inventory region. Confirm its exact
returned service, resource, required WHERE parameters, and output contract.
Date ranges, granularity, metrics, and grouping may be JSON-text input
parameters; supply the shapes required by the method and the host's UTC
boundaries rather than guessing SQL columns or local dates.

Only flag underutilization using accessible CloudWatch metrics or equivalent
observed evidence. Explain missing metrics, reservations, Savings Plans,
transfer, storage usage, and other unpriced components.
