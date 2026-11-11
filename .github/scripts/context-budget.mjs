// Compares the orchestrator's context budget on a pull request with the one on its base branch.
// A size that grew, or one the base did not measure yet, passes only with the context-increase
// label; a size that shrank or stayed passes as it is.
// Usage: node context-budget.mjs <base.json> <head.json> <labels as a JSON array>
import { readFileSync } from "node:fs";

const LABEL = "context-increase";
const [basePath, headPath, labelsJson] = process.argv.slice(2);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const base = read(basePath);
const head = read(headPath);
const labels = JSON.parse(labelsJson || "[]");

const grown = Object.entries(head).flatMap(([name, bytes]) => {
  const before = base[name];
  if (typeof before !== "number") return [`${name}: ${bytes} bytes, not measured on the base branch`];
  return bytes > before ? [`${name}: ${before} -> ${bytes} bytes (+${bytes - before})`] : [];
});

for (const [name, bytes] of Object.entries(head)) {
  const before = base[name];
  if (typeof before === "number" && bytes < before) console.log(`${name}: ${before} -> ${bytes} bytes`);
}

if (!grown.length) {
  console.log("No context the orchestrator gives an agent grew.");
  process.exit(0);
}
console.log(`Context the orchestrator gives an agent grew:\n${grown.map((line) => `  ${line}`).join("\n")}`);
if (labels.includes(LABEL)) {
  console.log(`The ${LABEL} label is set, so the growth is accepted.`);
  process.exit(0);
}
console.log(`Every task pays for these bytes. Add the ${LABEL} label once the growth is meant.`);
process.exit(1);
