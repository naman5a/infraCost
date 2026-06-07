# proj-cost

Monthly cost estimates for **GCP Terraform** projects, priced live from GCP's
[Cloud Billing Catalog API](https://cloud.google.com/billing/v1/how-tos/catalog-api).
A minimal, GCP-only take on [infracost](https://github.com/infracost/infracost).

```bash
npm install && npm run build

# from a terraform directory (runs terraform init/plan/show for you):
node dist/main.js breakdown --path /path/to/terraform

# or from an existing plan JSON (no terraform/credentials needed):
terraform show -json tfplan > plan.json
node dist/main.js breakdown --plan-json plan.json

# machine-readable output:
node dist/main.js breakdown --plan-json plan.json --json
```

Requirements: Node ≥ 18, `terraform`, and `gcloud` logged in
(`gcloud auth print-access-token` is used to call the Billing Catalog API).

## How it works

```
terraform dir ──(terraform plan/show -json)──► plan.json
   plan.json ──► parser.ts   : extract google_* resources + resolve region (zone → region)
   resources ──► mappers.ts  : resource type → [CostComponent] each with a SKU filter
  components ──► pricing.ts  : match SKU in Cloud Billing Catalog (cached 24h locally)
      prices ──► engine.ts   : monthly cost = qty × unit price (730 hrs/month)
      result ──► report.ts   : table / JSON
```

Key GCP-specific facts the design is built around:

- **GCP prices cores and RAM, not machine types.** `e2-standard-4` is billed as
  4 × "E2 Instance Core" + 16 GB × "E2 Instance Ram". vCPU/RAM are derived from
  the machine type name (`mappers.ts: machineSpecs`).
- **SKUs are identified by description string** (e.g. `"SSD backed PD Capacity"`,
  `"Cloud SQL for PostgreSQL: Regional - vCPU in Mumbai"`), filtered by region
  and usage type (`OnDemand` / `Preemptible`).
- The full SKU catalog per service (~31k SKUs for Compute Engine) is fetched
  once and cached in `~/.proj-cost/cache/` with a 24h TTL — after the first
  run, pricing is offline and instant.

## Supported resources

| Type | Components |
|---|---|
| `google_compute_instance` | vCPU + RAM hours (incl. custom & preemptible), boot disk, local SSD |
| `google_compute_disk` | provisioned GB by type (pd-standard/balanced/ssd/extreme) |
| `google_compute_address` / `global_address` | static IP hours (assumes attached to running VM) |
| `google_storage_bucket` | storage price shown; usage-based (qty unknown from plan) |
| `google_sql_database_instance` | vCPU + RAM (db-custom-\*), storage; zonal & regional |
| `google_container_cluster` | management fee, default node pool |
| `google_container_node_pool` | nodes (vCPU/RAM × count) + boot disks |

Anything else is listed under "unsupported" in the report (except known-free
types like service accounts, IAM, VPC — see `FREE_TYPES`).

## Adding a resource type

Add one function to `src/mappers.ts` and register it:

```ts
const redisInstance: Mapper = (r) => [{
  name: `Redis (${r.values.tier}, ${r.values.memory_size_gb} GB)`,
  unit: "GB-hours",
  monthlyQty: 730 * r.values.memory_size_gb,
  skuFilter: {
    service: "Cloud Memorystore for Redis",
    descriptionRegex: "^Redis Capacity Basic",
    region: r.region,
  },
}];
REGISTRY["google_redis_instance"] = redisInstance;
```

To find the right `descriptionRegex`, grep the cached catalog:
`node -e "..."` over `~/.proj-cost/cache/skus-*.json`, or browse SKUs at
https://cloud.google.com/skus.

## Known limitations (v0)

- List prices only: no sustained-use discounts, committed-use discounts, or free tiers.
- No network egress, no GPUs, no usage-based quantities (bucket GB, operations).
- No diff mode (compare two plans) yet.
- Shared-core SQL tiers (`db-f1-micro`) and non-custom SQL tiers unsupported.
