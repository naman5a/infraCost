// Stage 5: resolve prices and do the math. cost = monthlyQty × price.
import { REGISTRY, FREE_TYPES } from "./mappers.js";
import { findPrice } from "./pricing.js";
import { BreakdownResult, CostComponent, CostedResource, TfResource } from "./types.js";

async function priceComponent(c: CostComponent): Promise<void> {
  if (c.skuFilter) {
    try {
      const sku = await findPrice(c.skuFilter);
      if (sku) {
        c.price = sku.price;
      } else if (c.fixedPrice !== undefined) {
        c.price = c.fixedPrice;
        c.priceNote = "fallback price (SKU not found)";
      } else {
        c.priceNote = c.priceNote ?? "price not found";
      }
    } catch (err: any) {
      if (c.fixedPrice !== undefined) {
        c.price = c.fixedPrice;
        c.priceNote = "fallback price (API error)";
      } else {
        c.priceNote = `price lookup failed: ${err.message?.slice(0, 80)}`;
      }
    }
  } else if (c.fixedPrice !== undefined) {
    c.price = c.fixedPrice;
  }

  c.monthlyCost = c.price !== undefined ? c.price * c.monthlyQty : 0;
}

export async function breakdown(resources: TfResource[]): Promise<BreakdownResult> {
  const costed: CostedResource[] = [];
  const unsupported: Record<string, number> = {};

  for (const r of resources) {
    const mapper = REGISTRY[r.type];
    if (!mapper) {
      if (!FREE_TYPES.has(r.type)) {
        unsupported[r.type] = (unsupported[r.type] ?? 0) + 1;
      }
      continue;
    }

    const components = mapper(r);
    for (const c of components) await priceComponent(c);

    costed.push({
      address: r.address,
      type: r.type,
      components,
      monthlyCost: components.reduce((sum, c) => sum + (c.monthlyCost ?? 0), 0),
    });
  }

  return {
    resources: costed,
    unsupported,
    totalMonthlyCost: costed.reduce((sum, r) => sum + r.monthlyCost, 0),
  };
}
