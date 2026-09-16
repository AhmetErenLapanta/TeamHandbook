import { resolve } from "node:path";
import { intakeSkill } from "../lib/queue.js";

const source = process.argv[2];
if (!source) {
  console.error("usage: share-skill.js <path to a skill directory>");
  process.exit(2);
}

const result = intakeSkill(resolve(source));
if (!result.ok) {
  console.error(`error: ${result.error}`);
  process.exit(1);
}

const extras = (result.fileCount ?? 1) - 1;
console.log(
  `Queued "${result.slug}" for review${extras > 0 ? ` with its ${extras} other file(s)` : ""}. ` +
    `Run /handbook:review to share it with your team, add it to this project, or keep it.`,
);
