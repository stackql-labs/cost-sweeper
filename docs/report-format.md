# Report contract

This is a data interchange contract, not business configuration. Policy,
scope, pricing assumptions, and investigation priorities belong in the prose
configuration. Each isolated Copilot SDK worker submits one provider object
to the application-owned result tool. The application validates and collates
all provider objects in memory. Do not save intermediate files.

The top-level object has generatedAt (a UTC ISO timestamp), summary (nonempty
text), and providers (an array containing every selected provider exactly once).
No extra provider may appear.
The application reads the selected prose policies and this contract at the
start of every sweep, then supplies a UTC generatedAt value and exact
billingWindow boundaries to each worker. Use that timestamp verbatim instead
of deriving UTC dates from local time.
Summary is the model's concise synthesis of the collected evidence, not a copy
of resource rows. Findings and recommendations should likewise prioritize
material costs, actionable changes, and limitations.

Each provider object has:

- name: the selected registry identifier.
- status: complete, partial, or failed. Complete requires no gaps or errors,
  no unpriced resources, available billing history, and complete comparable
  days for the preceding two calendar weeks. This is the agent's evidenced
  assertion of coverage, not a guarantee inferred by the renderer.
- coverage: an array of descriptions of inspected scopes and services,
  including query/source evidence and pagination completeness. Required for
  complete and partial results.
- gaps: an array of missing scopes, pricing, metered components, utilization,
  billing history, pagination, or other omissions.
- errors: an array of safe, actionable failure summaries, never raw payloads
  or secrets. Failed requires an error and no collected resources or spend.
  Partial requires a gap or error.
- findings and recommendations: arrays of evidenced descriptions. Include
  resource IDs, impact, assumptions, risk, and source as applicable.
- resources: an array of objects as described below. Empty means nothing was
  observed; only scope evidence can establish an empty estate.
- spend: null when unavailable, otherwise an object with source, basis, and
  daily. Source cites the billing query/export and observation time. Basis
  describes amortization, taxes, credits, and exclusions consistently.

Each resource has nonempty id, service, scope, region, state, basis, and source
strings; assumptions (an array of strings); confidence (high, medium, low,
or unknown); dailyCost (a finite nonnegative number or null); and currency
(a three-letter uppercase currency code, or null only for unpriced resources).
Use "global" when a resource is not regional. Use "unknown" for an unobserved
state, and record this limitation. The identity tuple name/scope/service/region/id
must be unique. Include one row per billable resource, not duplicate rows for
each pricing component.

Basis contains the rate, unit, observed capacity or usage, and formula.
Source identifies verified pricing metadata, SKU, region, effective date,
and query/source locator. For unknown costs, basis and source instead explain
what is unavailable. Partial estimates must explicitly say which components
they cover; any unknown component belongs in gaps. Zero requires evidence.
The renderer sums known dailyCost values by currency and counts unpriced rows.
Do not submit aggregate totals; the renderer calculates them.

Each spend.daily entry has date (a real YYYY-MM-DD UTC day before generatedAt's
day), currency, amount (a finite number, negative credits allowed), and complete
(boolean). There must be at most one entry per date/currency. Aggregate service
rows first using a consistent billing basis. Never fill missing dates with zero.
An incomplete day's value may be displayed but is excluded from comparisons.
This applies only to past UTC days. A current UTC day's row must not be submitted,
even with complete=false. Past dates are not automatically complete: provider
estimated/finalized flags and reporting lag determine that assertion.
Different currencies are independent series, never converted or summed.

Trends use the 14 calendar days immediately before generatedAt's UTC day:
seven prior days against seven recent days. Every day must exist and be complete
for that currency. If billing lag leaves a gap, the trend is unavailable, not
silently shifted to stale weeks. Percentage change is unavailable for a
nonpositive baseline, except zero against zero which is a zero change.
The renderer reports numerical changes; the agent applies prose thresholds
and decides evidenced findings.

## Minimal partial example

This is illustrative, not collected cloud evidence:

```json
{
  "generatedAt": "2026-11-15T20:30:00Z",
  "summary": "AWS inventory observed; pricing and billing access unavailable.",
  "providers": [
    {
      "name": "aws",
      "status": "partial",
      "coverage": ["Example account, us-east-1: EC2 list completed; illustrative only."],
      "gaps": ["Other regions not inspected.", "Pricing and daily billing unavailable."],
      "errors": [],
      "findings": [],
      "recommendations": [],
      "resources": [
        {
          "id": "example-instance",
          "service": "ec2",
          "scope": "example-account",
          "region": "us-east-1",
          "state": "running",
          "currency": null,
          "dailyCost": null,
          "confidence": "unknown",
          "basis": "SKU price unavailable; no estimate invented.",
          "source": "Illustrative example only, not a live query.",
          "assumptions": []
        }
      ],
      "spend": null
    }
  ]
}
```

## SDK worker and renderer flow

The application launches one isolated GitHub Copilot SDK session per selected
provider. Each session receives only the read-only StackQL tools and a strict
SDK response schema for its final provider JSON object. The application reads
that response directly and validates it against collected evidence. Validation
errors are returned to that worker for correction. The application collates
all accepted results and passes the complete report directly to the existing
report validator and publisher. No reporting MCP server or model-authored
shell command is used.

A valid incomplete report returns process exit code 2. This distinguishes
partial or failed provider coverage from an application runtime failure,
which returns exit code 1. Validation and filesystem errors are explicit.

The standalone stdin renderer remains available for manual use.
Windows PowerShell, from the project root:

```powershell
@'
{ ... report JSON ... }
'@ | node scripts\cost-sweep.mjs report aws
```

Append --output-md to request both console and Markdown output. JSON must not
contain a standalone here-string terminator line; escape it inside JSON strings.

The SDK application's console output uses tables for provider status, known
daily subtotals by currency, billing trends, resource inventory, coverage,
gaps, errors, findings, recommendations, and observed model usage. The optional
Markdown report retains all resource formulas, sources, assumptions, and daily
billing rows. The standalone stdin renderer retains its bounded boxed summary.

The SDK workers return evidence directly to the application. The application
does not depend on host-managed temporary captures or truncated MCP previews.
Default rendering does not write a report file.

Exit code 0 means all reported provider statuses are complete. Code 2 means
a valid but incomplete report (partial or failed providers). Code 1 means
argument, validation, input, launch, or filesystem failure. Invalid JSON errors
do not echo the submitted payload.
