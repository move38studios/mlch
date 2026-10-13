// Release checklist: what fal released since the picks in src/lib/media/picks.ts were checked.
// Prints, per category, the newest models and whether they are already picked. No key needed.
// node scripts/fal-picks.mjs [limit]
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src/lib/media/picks.ts"), "utf8");
const checked = source.match(/PICKS_CHECKED = "([^"]+)"/)[1];
const picked = new Set([...source.matchAll(/endpoint: "([^"]+)"/g)].map((m) => m[1]));
const categories = [...source.matchAll(/^  "([a-z0-9-]+)": \{$/gm)].map((m) => m[1]);
const limit = Number(process.argv[2] ?? 12);

console.log(`Picks checked ${checked}.`);
for (const category of categories) {
  const response = await fetch(`https://api.fal.ai/v1/models?status=active&sort=recent&limit=${limit}&category=${category}`);
  if (!response.ok) {
    console.log(`\n${category}: ${response.status}`);
    continue;
  }
  const { models } = await response.json();
  console.log(`\n${category}`);
  for (const m of models) {
    const date = (m.metadata?.date ?? "").slice(0, 10);
    const mark = picked.has(m.endpoint_id) ? "picked" : date > checked ? "NEW" : "";
    console.log(`  ${date}  ${mark.padEnd(6)}  ${m.endpoint_id}  ${m.metadata?.display_name ?? ""}`);
  }
}
