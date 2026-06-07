#!/usr/bin/env node
// proj-cost — monthly cost estimates for GCP Terraform projects.
//
//   proj-cost breakdown --path <terraform-dir>     # runs terraform plan for you
//   proj-cost breakdown --plan-json <plan.json>    # use an existing plan JSON
//
// Flags: --json (machine-readable output), --skip-init, --region <fallback-region>
import { readFileSync } from "node:fs";
import { breakdown } from "./engine.js";
import { parsePlan } from "./parser.js";
import { generatePlanJson } from "./planner.js";
import { renderJson, renderTable } from "./report.js";
function flag(args, name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
}
const USAGE = `proj-cost — GCP Terraform cost estimation

Usage:
  proj-cost breakdown --path <terraform-dir>   [--json] [--skip-init] [--region <region>]
  proj-cost breakdown --plan-json <plan.json>  [--json] [--region <region>]
`;
async function main() {
    const args = process.argv.slice(2);
    if (args[0] !== "breakdown") {
        console.error(USAGE);
        process.exit(args[0] === "--help" || args[0] === "-h" ? 0 : 1);
    }
    const path = flag(args, "--path");
    const planJsonPath = flag(args, "--plan-json");
    const fallbackRegion = flag(args, "--region") ?? "us-central1";
    let plan;
    if (planJsonPath) {
        plan = JSON.parse(readFileSync(planJsonPath, "utf8"));
    }
    else if (path) {
        plan = generatePlanJson(path, args.includes("--skip-init"));
    }
    else {
        console.error(USAGE);
        process.exit(1);
    }
    const { resources, defaultRegion } = parsePlan(plan, fallbackRegion);
    console.error(`→ ${resources.length} google_* resources found (default region: ${defaultRegion})`);
    const result = await breakdown(resources);
    console.log(args.includes("--json") ? renderJson(result) : renderTable(result));
}
main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
