// Core data model — shapes borrowed from infracost's schema.

/** A resource extracted from terraform plan JSON. */
export interface TfResource {
  address: string; // "google_compute_instance.app"
  type: string; // "google_compute_instance"
  values: any; // evaluated attribute values from planned_values
  region: string; // resolved region, e.g. "asia-south1"
}

/** How to find a price in the GCP Cloud Billing Catalog. */
export interface SkuFilter {
  service: string; // Billing Catalog service displayName, e.g. "Compute Engine"
  descriptionRegex: string; // matched against sku.description
  region: string; // matched against sku.serviceRegions (or "global")
  usageType?: string; // "OnDemand" (default) | "Preemptible" | "Commit1Yr" ...
}

/** One billable line item of a resource. cost = monthlyQty × price. */
export interface CostComponent {
  name: string; // "Instance usage: 4 vCPU (e2)"
  unit: string; // "core-hours" | "GB" | ...
  monthlyQty: number;
  skuFilter?: SkuFilter; // price looked up in the catalog
  fixedPrice?: number; // fallback / hardcoded $-per-unit (used if lookup fails or no filter)
  usageBased?: boolean; // qty depends on usage we can't know from the plan

  // filled in by the pricing/engine stages:
  price?: number; // $ per unit
  monthlyCost?: number;
  priceNote?: string; // e.g. "fallback price", "price not found"
}

export interface CostedResource {
  address: string;
  type: string;
  components: CostComponent[];
  monthlyCost: number;
}

export interface BreakdownResult {
  resources: CostedResource[];
  unsupported: Record<string, number>; // resource type → count
  totalMonthlyCost: number;
}

export const HOURS_PER_MONTH = 730;
