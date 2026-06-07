/** "asia-south1-a" → "asia-south1" */
export function zoneToRegion(zone) {
    const parts = zone.split("-");
    return parts.length >= 3 ? parts.slice(0, -1).join("-") : zone;
}
/** Region from the google provider block, if statically known. */
function providerRegion(plan) {
    const cfgs = plan?.configuration?.provider_config ?? {};
    for (const key of Object.keys(cfgs)) {
        if (key === "google" || key.startsWith("google.") || key === "google-beta") {
            const region = cfgs[key]?.expressions?.region?.constant_value;
            if (region)
                return region;
        }
    }
    return undefined;
}
/** A location can be a zone, a region, or a multi-region ("US"). Normalize it. */
function resolveRegion(values, fallback) {
    if (values?.zone)
        return zoneToRegion(values.zone);
    if (values?.region)
        return values.region;
    if (values?.location) {
        const loc = String(values.location).toLowerCase();
        // zone-shaped locations like "asia-south1-a"
        return /^[a-z]+-[a-z]+\d+-[a-z]$/.test(loc) ? zoneToRegion(loc) : loc;
    }
    return fallback;
}
function walkModule(mod, out) {
    for (const r of mod?.resources ?? [])
        out.push(r);
    for (const child of mod?.child_modules ?? [])
        walkModule(child, out);
}
export function parsePlan(plan, fallbackRegion) {
    const defaultRegion = providerRegion(plan) ?? fallbackRegion;
    const raw = [];
    walkModule(plan?.planned_values?.root_module, raw);
    const resources = raw
        .filter((r) => r.mode !== "data" && r.type?.startsWith("google_"))
        .map((r) => ({
        address: r.address,
        type: r.type,
        values: r.values ?? {},
        region: resolveRegion(r.values, defaultRegion),
    }));
    return { resources, defaultRegion };
}
