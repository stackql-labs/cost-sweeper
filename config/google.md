# Google Cloud estate

Use the google registry provider, also selected by the gcp positional alias.
GOOGLE_CREDENTIALS in .env is the full service account key JSON, not a path.
StackQL reads it locally. Do not load the JSON into the agent's context.

Discover projects accessible to the service account, then inspect their
regions and zones. Honor project and billing-account permissions separately.
To restrict this sweep, replace this paragraph with the desired project IDs
and billing accounts in ordinary prose. A service account's own project is
not proof that it is the only project in the estate.

Prioritize Compute Engine instances, persistent disks and snapshots, Cloud
Storage bucket-level usage, Cloud SQL, GKE node capacity and control-plane
charges, external addresses, load balancers, Cloud NAT, Cloud Run, and material
managed data services. Stopped VM persistent disks remain billable. Avoid
double counting GKE workloads, their nodes, and cluster-level aggregate costs.

Discover Cloud Billing catalog/pricing metadata for current regional SKUs.
Match machine family, CPU and memory components, storage class, disk capacity,
location, and billing units. Use observed sustained-use or committed-use
discounts only when supported by evidence. Metered services need usage data.

Cloud Billing account and catalog APIs alone do not provide historical daily
spend. Look for an existing accessible billing export or other supported
read-only source. If an export location is known, add its project, dataset,
and table to this prose. Do not create exports or run paid BigQuery query
jobs through lifecycle or mutation tools. If no no-cost read path exists,
report historical spend as unavailable and continue current inventory.
Use observed monitoring data for utilization findings and label missing
storage bytes, request counts, egress, or billing export access as gaps.
