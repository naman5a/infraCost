// Stage 3: map a terraform resource → cost components with SKU filters.
// SKU description patterns mirror infracost's GCP resource builders
// (the Cloud Billing Catalog identifies SKUs mostly by description string).
import { HOURS_PER_MONTH } from "./types.js";
const SHARED_CORE = {
    "e2-micro": { cpu: 0.25, ramGb: 1 },
    "e2-small": { cpu: 0.5, ramGb: 2 },
    "e2-medium": { cpu: 1, ramGb: 4 },
};
const RAM_PER_CPU = {
    standard: 4,
    highmem: 8,
    highcpu: 1,
};
/** Derive vCPU/RAM from the machine type name (GCP bills cores + RAM, not machine types). */
export function machineSpecs(machineType) {
    const mt = machineType.toLowerCase();
    if (SHARED_CORE[mt])
        return { ...SHARED_CORE[mt], family: mt.split("-")[0] };
    const parts = mt.split("-");
    const family = parts[0];
    // custom types: "custom-4-16384" (n1) or "n2-custom-4-16384"
    const ci = parts.indexOf("custom");
    if (ci !== -1 && parts.length >= ci + 3) {
        const cpu = parseInt(parts[ci + 1], 10);
        const ramMb = parseInt(parts[ci + 2], 10);
        if (!isNaN(cpu) && !isNaN(ramMb)) {
            return { cpu, ramGb: ramMb / 1024, family: ci === 0 ? "n1" : family };
        }
        return null;
    }
    if (parts.length === 3) {
        const kind = parts[1];
        const cpu = parseInt(parts[2], 10);
        const perCpu = RAM_PER_CPU[kind];
        if (!isNaN(cpu) && perCpu !== undefined) {
            // n1 has lower ratios than the generic ones
            const ramGb = family === "n1"
                ? cpu * { standard: 3.75, highmem: 6.5, highcpu: 0.9 }[kind]
                : cpu * perCpu;
            return { cpu, ramGb, family };
        }
    }
    return null;
}
/** Catalog description prefixes per machine family (core + ram SKUs). */
const FAMILY_DESC = {
    e2: { core: "E2 Instance Core running in", ram: "E2 Instance Ram running in" },
    n1: { core: "N1 Predefined Instance Core running in", ram: "N1 Predefined Instance Ram running in" },
    n2: { core: "N2 Instance Core running in", ram: "N2 Instance Ram running in" },
    n2d: { core: "N2D AMD Instance Core running in", ram: "N2D AMD Instance Ram running in" },
    t2d: { core: "T2D AMD Instance Core running in", ram: "T2D AMD Instance Ram running in" },
    c2: { core: "Compute optimized Core running in", ram: "Compute optimized Ram running in" },
    c2d: { core: "C2D AMD Instance Core running in", ram: "C2D AMD Instance Ram running in" },
    c3: { core: "C3 Instance Core running in", ram: "C3 Instance Ram running in" },
    m1: { core: "Memory-optimized Instance Core running in", ram: "Memory-optimized Instance Ram running in" },
};
/** Cost components for one VM of `machineType` running 730 hrs/month. */
function vmComponents(machineType, region, preemptible, count = 1, labelSuffix = "") {
    const specs = machineSpecs(machineType);
    const usageType = preemptible ? "Preemptible" : "OnDemand";
    const descPrefix = preemptible ? "Spot Preemptible " : "";
    const optLabel = preemptible ? "preemptible" : "on-demand";
    if (!specs || !FAMILY_DESC[specs.family]) {
        return [
            {
                name: `Instance usage (${machineType}, unsupported machine type)${labelSuffix}`,
                unit: "hours",
                monthlyQty: HOURS_PER_MONTH * count,
                priceNote: "machine type not supported",
            },
        ];
    }
    const fam = FAMILY_DESC[specs.family];
    return [
        {
            name: `Instance: ${specs.cpu * count} vCPU (${machineType}, ${optLabel})${labelSuffix}`,
            unit: "core-hours",
            monthlyQty: HOURS_PER_MONTH * specs.cpu * count,
            skuFilter: {
                service: "Compute Engine",
                descriptionRegex: `^${descPrefix}${fam.core}`,
                region,
                usageType,
            },
        },
        {
            name: `Instance: ${specs.ramGb * count} GB RAM (${machineType}, ${optLabel})${labelSuffix}`,
            unit: "GB-hours",
            monthlyQty: HOURS_PER_MONTH * specs.ramGb * count,
            skuFilter: {
                service: "Compute Engine",
                descriptionRegex: `^${descPrefix}${fam.ram}`,
                region,
                usageType,
            },
        },
    ];
}
// ------------------------------------------------------------------- disks
const DISK_DESC = {
    "pd-standard": "^Storage PD Capacity",
    "pd-balanced": "^Balanced PD Capacity",
    "pd-ssd": "^SSD backed PD Capacity",
    "pd-extreme": "^Extreme PD Capacity",
};
function diskComponent(diskType, sizeGb, region, label) {
    const desc = DISK_DESC[diskType] ?? DISK_DESC["pd-standard"];
    return {
        name: `${label} (${diskType}, ${sizeGb} GB)`,
        unit: "GB-months",
        monthlyQty: sizeGb,
        skuFilter: { service: "Compute Engine", descriptionRegex: desc, region },
    };
}
// ---------------------------------------------------------------- mappers
const computeInstance = (r) => {
    const v = r.values;
    const preemptible = Boolean(v.scheduling?.[0]?.preemptible);
    const components = vmComponents(v.machine_type ?? "", r.region, preemptible);
    const init = v.boot_disk?.[0]?.initialize_params?.[0];
    if (init) {
        components.push(diskComponent(init.type ?? "pd-standard", init.size ?? 10, r.region, "Boot disk"));
    }
    for (const sd of v.scratch_disk ?? []) {
        components.push({
            name: "Local SSD (scratch, 375 GB)",
            unit: "GB-months",
            monthlyQty: 375,
            skuFilter: { service: "Compute Engine", descriptionRegex: "^SSD backed Local Storage", region: r.region },
        });
    }
    if ((v.guest_accelerator ?? []).length > 0) {
        components.push({
            name: "Guest accelerator (GPU) — not priced in v0",
            unit: "hours",
            monthlyQty: HOURS_PER_MONTH,
            priceNote: "GPUs not supported yet",
        });
    }
    return components;
};
const computeDisk = (r) => {
    const v = r.values;
    return [diskComponent(v.type ?? "pd-standard", v.size ?? 10, r.region, "Provisioned storage")];
};
const computeAddress = (r) => [
    {
        // An IP attached to a running standard VM bills as "External IP Charge on a
        // Standard VM"; a reserved-but-unused IP bills higher ("Static Ip Charge").
        // We assume the IP is in use.
        name: "Static external IP (assumes attached to a running VM)",
        unit: "hours",
        monthlyQty: HOURS_PER_MONTH,
        skuFilter: {
            service: "Compute Engine",
            descriptionRegex: "^External IP Charge on a Standard VM",
            region: r.region,
        },
    },
];
const STORAGE_CLASS_DESC = {
    STANDARD: "^Standard Storage",
    NEARLINE: "^Nearline Storage",
    COLDLINE: "^Coldline Storage",
    ARCHIVE: "^Archive Storage",
};
const storageBucket = (r) => {
    const cls = (r.values.storage_class ?? "STANDARD").toUpperCase();
    return [
        {
            name: `Storage (${cls.toLowerCase()})`,
            unit: "GB-months",
            monthlyQty: 0, // usage-based: we can't know stored bytes from the plan
            usageBased: true,
            skuFilter: {
                service: "Cloud Storage",
                descriptionRegex: STORAGE_CLASS_DESC[cls] ?? STORAGE_CLASS_DESC.STANDARD,
                region: r.region,
            },
        },
    ];
};
const sqlDatabaseInstance = (r) => {
    const v = r.values;
    const settings = v.settings?.[0] ?? {};
    const ver = v.database_version ?? "POSTGRES_15";
    const engine = ver.startsWith("POSTGRES") ? "PostgreSQL" : ver.startsWith("MYSQL") ? "MySQL" : "SQL Server";
    const availability = settings.availability_type === "REGIONAL" ? "Regional" : "Zonal";
    const tier = settings.tier ?? "";
    const components = [];
    // db-custom-<cpu>-<ramMB> — the common modern tier shape
    const m = tier.match(/^db-custom-(\d+)-(\d+)$/);
    if (m) {
        const cpu = parseInt(m[1], 10);
        const ramGb = parseInt(m[2], 10) / 1024;
        components.push({
            name: `SQL vCPU (${engine}, ${availability.toLowerCase()}, ${cpu} vCPU)`,
            unit: "core-hours",
            monthlyQty: HOURS_PER_MONTH * cpu,
            skuFilter: {
                service: "Cloud SQL",
                descriptionRegex: `^Cloud SQL for ${engine}: ${availability} - vCPU`,
                region: r.region,
            },
        }, {
            name: `SQL RAM (${engine}, ${availability.toLowerCase()}, ${ramGb} GB)`,
            unit: "GB-hours",
            monthlyQty: HOURS_PER_MONTH * ramGb,
            skuFilter: {
                service: "Cloud SQL",
                descriptionRegex: `^Cloud SQL for ${engine}: ${availability} - RAM`,
                region: r.region,
            },
        });
    }
    else {
        components.push({
            name: `SQL instance (${tier || "unknown tier"}) — tier not supported in v0`,
            unit: "hours",
            monthlyQty: HOURS_PER_MONTH,
            priceNote: "only db-custom-* tiers supported",
        });
    }
    const diskGb = settings.disk_size ?? 10;
    const diskDesc = settings.disk_type === "PD_HDD"
        ? `^Cloud SQL for ${engine}: ${availability} - Low cost storage`
        : `^Cloud SQL for ${engine}: ${availability} - Standard storage`;
    components.push({
        name: `SQL storage (${settings.disk_type ?? "PD_SSD"}, ${diskGb} GB)`,
        unit: "GB-months",
        monthlyQty: diskGb,
        skuFilter: { service: "Cloud SQL", descriptionRegex: diskDesc, region: r.region },
    });
    return components;
};
const containerCluster = (r) => {
    const v = r.values;
    const loc = v.location ?? "";
    const isRegional = !/^[a-z]+-[a-z]+\d+-[a-z]$/.test(loc); // zone-shaped → zonal
    const components = [
        {
            name: `Cluster management fee (${isRegional ? "regional" : "zonal"})`,
            unit: "hours",
            monthlyQty: HOURS_PER_MONTH,
            skuFilter: {
                service: "Kubernetes Engine",
                descriptionRegex: isRegional ? "^Regional Kubernetes Clusters" : "^Zonal Kubernetes Clusters",
                region: r.region,
            },
            fixedPrice: 0.1, // GKE flat fee fallback if the SKU isn't found
        },
    ];
    // default node pool (unless removed)
    if (!v.remove_default_node_pool) {
        const nodes = v.initial_node_count ?? 3;
        const mt = v.node_config?.[0]?.machine_type ?? "e2-medium";
        components.push(...vmComponents(mt, r.region, false, nodes, ` × ${nodes} default nodes`), diskComponent(v.node_config?.[0]?.disk_type ?? "pd-balanced", (v.node_config?.[0]?.disk_size_gb ?? 100) * nodes, r.region, `Node boot disks × ${nodes}`));
    }
    return components;
};
const containerNodePool = (r) => {
    const v = r.values;
    const nodes = v.node_count ?? v.initial_node_count ?? v.autoscaling?.[0]?.min_node_count ?? 3;
    const cfg = v.node_config?.[0] ?? {};
    const preemptible = Boolean(cfg.preemptible || cfg.spot);
    return [
        ...vmComponents(cfg.machine_type ?? "e2-medium", r.region, preemptible, nodes, ` × ${nodes} nodes`),
        diskComponent(cfg.disk_type ?? "pd-balanced", (cfg.disk_size_gb ?? 100) * nodes, r.region, `Node boot disks × ${nodes}`),
    ];
};
// ---------------------------------------------------------------- registry
export const REGISTRY = {
    google_compute_instance: computeInstance,
    google_compute_disk: computeDisk,
    google_compute_address: computeAddress,
    google_compute_global_address: computeAddress,
    google_storage_bucket: storageBucket,
    google_sql_database_instance: sqlDatabaseInstance,
    google_container_cluster: containerCluster,
    google_container_node_pool: containerNodePool,
};
/** Resource types that exist in plans but never cost anything — don't report as "unsupported". */
export const FREE_TYPES = new Set([
    "google_project_iam_member",
    "google_project_iam_binding",
    "google_project_iam_policy",
    "google_service_account",
    "google_service_account_iam_member",
    "google_compute_network",
    "google_compute_subnetwork",
    "google_compute_firewall",
    "google_storage_bucket_iam_member",
    "google_project_service",
]);
