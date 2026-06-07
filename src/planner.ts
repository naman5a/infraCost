// Stage 1: run terraform to produce plan JSON.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

function tf(args: string[], cwd: string, capture = false): string {
  const res = spawnSync("terraform", args, {
    cwd,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`terraform ${args[0]} failed (exit ${res.status})`);
  }
  return capture ? res.stdout : "";
}

/** Runs terraform init/plan/show in `dir` and returns the parsed plan JSON. */
export function generatePlanJson(dir: string, skipInit = false): any {
  if (!skipInit && !existsSync(join(dir, ".terraform"))) {
    console.error(`→ terraform init (${dir})`);
    tf(["init", "-input=false"], dir);
  }

  const planFile = ".proj-cost.tfplan";
  try {
    console.error("→ terraform plan");
    tf(["plan", "-input=false", `-out=${planFile}`], dir);
    console.error("→ terraform show -json");
    const out = tf(["show", "-json", planFile], dir, true);
    return JSON.parse(out);
  } finally {
    rmSync(join(dir, planFile), { force: true });
  }
}
