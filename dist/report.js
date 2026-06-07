const money = (n) => `$${n.toFixed(2)}`;
const price = (n) => (n === undefined ? "-" : `$${n.toFixed(n < 0.01 ? 6 : 4)}`);
const qty = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
export function renderTable(result) {
    const rows = [];
    rows.push(["NAME", "QTY", "UNIT", "PRICE", "MONTHLY COST"]);
    for (const r of result.resources) {
        rows.push([r.address, "", "", "", money(r.monthlyCost)]);
        r.components.forEach((c, i) => {
            const branch = i === r.components.length - 1 ? "└─" : "├─";
            const note = c.usageBased
                ? "  (usage-based)"
                : c.priceNote
                    ? `  (${c.priceNote})`
                    : "";
            rows.push([
                `${branch} ${c.name}${note}`,
                c.usageBased ? "-" : qty(c.monthlyQty),
                c.unit,
                price(c.price),
                c.usageBased ? "-" : money(c.monthlyCost ?? 0),
            ]);
        });
        rows.push(["", "", "", "", ""]);
    }
    const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
    const line = (row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ");
    const out = [];
    out.push(line(rows[0]));
    out.push("─".repeat(widths.reduce((a, b) => a + b + 2, -2)));
    for (const row of rows.slice(1))
        out.push(line(row).trimEnd());
    out.push("─".repeat(widths.reduce((a, b) => a + b + 2, -2)));
    out.push(line(["PROJECT TOTAL (monthly)", "", "", "", money(result.totalMonthlyCost)]));
    const unsup = Object.entries(result.unsupported);
    if (unsup.length > 0) {
        out.push("");
        out.push("Resource types without a cost mapping (not included in total):");
        for (const [type, count] of unsup)
            out.push(`  - ${type} × ${count}`);
    }
    out.push("");
    out.push("Note: prices are list prices from GCP's Cloud Billing Catalog (USD).");
    out.push("Sustained-use discounts, CUDs, free tiers and network egress are not modeled.");
    return out.join("\n");
}
export function renderJson(result) {
    return JSON.stringify(result, null, 2);
}
