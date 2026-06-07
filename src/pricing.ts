// Stage 4: prices from GCP's Cloud Billing Catalog API, cached locally.
//
// First use per service: pulls every SKU (paginated) and flattens to a small
// local cache (~/.proj-cost/cache). After that, lookups are offline & instant.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SkuFilter } from "./types.js";

const API = "https://cloudbilling.googleapis.com/v1";
const CACHE_DIR = join(homedir(), ".proj-cost", "cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface FlatSku {
  skuId: string;
  description: string;
  regions: string[];
  usageType: string; // OnDemand | Preemptible | Commit1Yr ...
  resourceFamily: string;
  unit: string; // "h", "GiBy.mo", ...
  price: number; // USD per unit
}

let accessToken: string | undefined;
function getToken(): string {
  if (!accessToken) {
    accessToken = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  }
  return accessToken;
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    throw new Error(`Billing Catalog API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function cacheRead(file: string): any | null {
  const p = join(CACHE_DIR, file);
  if (!existsSync(p)) return null;
  const data = JSON.parse(readFileSync(p, "utf8"));
  if (Date.now() - data.fetchedAt > CACHE_TTL_MS) return null;
  return data.payload;
}

function cacheWrite(file: string, payload: any): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, file), JSON.stringify({ fetchedAt: Date.now(), payload }));
}

/** displayName → "services/XXXX-..." mapping, cached. */
async function serviceId(displayName: string): Promise<string> {
  let services: Record<string, string> | null = cacheRead("services.json");
  if (!services) {
    services = {};
    let pageToken = "";
    do {
      const data = await apiGet(`/services?pageSize=5000${pageToken ? `&pageToken=${pageToken}` : ""}`);
      for (const s of data.services ?? []) services[s.displayName] = s.name;
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);
    cacheWrite("services.json", services);
  }
  const id = services[displayName];
  if (!id) throw new Error(`Billing Catalog service not found: "${displayName}"`);
  return id;
}

/** Pull the unit price from a SKU: first tier with a non-zero rate (skips free tiers). */
function skuPrice(sku: any): { price: number; unit: string } | null {
  const expr = sku.pricingInfo?.[0]?.pricingExpression;
  if (!expr?.tieredRates?.length) return null;
  const num = (r: any) => Number(r.unitPrice?.units ?? 0) + Number(r.unitPrice?.nanos ?? 0) / 1e9;
  const rate = expr.tieredRates.find((r: any) => num(r) > 0) ?? expr.tieredRates[0];
  return { price: num(rate), unit: expr.usageUnit ?? "" };
}

const skusByService = new Map<string, FlatSku[]>();

/** All SKUs of a service, flattened, from cache or the API. */
async function loadSkus(service: string): Promise<FlatSku[]> {
  if (skusByService.has(service)) return skusByService.get(service)!;

  const cacheFile = `skus-${service.replace(/\W+/g, "_")}.json`;
  let skus: FlatSku[] | null = cacheRead(cacheFile);

  if (!skus) {
    const id = await serviceId(service);
    console.error(`→ fetching SKU catalog for "${service}" (one-time, cached 24h)...`);
    skus = [];
    let pageToken = "";
    let pages = 0;
    do {
      const data = await apiGet(`/${id}/skus?pageSize=5000&currencyCode=USD${pageToken ? `&pageToken=${pageToken}` : ""}`);
      for (const sku of data.skus ?? []) {
        const p = skuPrice(sku);
        if (!p) continue;
        skus.push({
          skuId: sku.skuId,
          description: sku.description ?? "",
          regions: sku.serviceRegions ?? [],
          usageType: sku.category?.usageType ?? "",
          resourceFamily: sku.category?.resourceFamily ?? "",
          unit: p.unit,
          price: p.price,
        });
      }
      pageToken = data.nextPageToken ?? "";
      pages++;
    } while (pageToken);
    console.error(`  ${skus.length} SKUs across ${pages} pages`);
    cacheWrite(cacheFile, skus);
  }

  skusByService.set(service, skus);
  return skus;
}

/** Find the unit price for a filter. Returns null if no SKU matches. */
export async function findPrice(filter: SkuFilter): Promise<FlatSku | null> {
  const skus = await loadSkus(filter.service);
  const re = new RegExp(filter.descriptionRegex, "i");
  const usageType = filter.usageType ?? "OnDemand";

  const matches = skus.filter(
    (s) =>
      s.usageType === usageType &&
      re.test(s.description) &&
      (s.regions.includes(filter.region) || s.regions.includes("global"))
  );
  return matches[0] ?? null;
}
