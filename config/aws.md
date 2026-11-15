# AWS estate

Use the aws registry provider. Credentials are the AWS_ACCESS_KEY_ID and
AWS_SECRET_ACCESS_KEY in .env, plus AWS_SESSION_TOKEN for temporary sessions.
An empty or invalid credential set is an explicit coverage failure.

Start with STS caller identity to establish the current account. Discover
enabled regions, then inspect each accessible region. Inspect additional
accounts only if the supplied identity already has an authorized access path;
do not invent cross-account access. Global services must not be counted once
per region. To restrict the sweep, replace this paragraph with the desired
account IDs and regions in ordinary prose.

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

Only flag underutilization using accessible CloudWatch metrics or equivalent
observed evidence. Explain missing metrics, reservations, Savings Plans,
transfer, storage usage, and other unpriced components.
