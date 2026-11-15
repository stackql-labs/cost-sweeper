# Azure estate

Use the azure registry provider. The local .env contains AZURE_TENANT_ID,
AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET for a service principal. Inventory
requires read access to each included subscription. Billing and monitoring
may require separate read roles.

Discover all subscriptions accessible to the service principal in its tenant.
Inventory resource groups and resources within those subscriptions across
their observed regions. To restrict this sweep, replace this paragraph with
the desired subscription IDs and resource groups in ordinary prose. An
inaccessible subscription is a gap, not evidence that it contains no resources.

Prioritize virtual machines and scale sets, managed disks and snapshots,
storage accounts, Azure SQL and other managed databases, AKS backing nodes,
App Service plans, load balancers, NAT gateways, public IPs, and material
managed services. Distinguish stopped from deallocated virtual machines.
Disks remain billable when compute is deallocated. Do not double count App
Service applications and their shared plans or AKS nodes and cluster totals.

Discover Cost Management methods and their supported scope and request shape.
Read daily actual cost for the last 30 complete UTC days with a consistent
amortization basis, currency, and tax treatment. Do not issue a mutation to
obtain billing data. If the needed cost-query endpoint is unavailable through
the read-only SELECT surface, state that billing is unavailable rather than
switching to an unrestricted server. Use existing accessible exports only
when their content can be read without launching paid analysis jobs.

Use verified Azure retail or observed negotiated pricing available through
StackQL metadata, not remembered VM rates. Match region, SKU, OS/license,
redundancy, tier, and unit. Record unavailable pricing surfaces explicitly.
Use Azure Monitor or Advisor evidence where accessible for recommendations;
resource existence alone does not prove idleness.
