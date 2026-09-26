// Reading back what a harvest wrote. The behavioral layer needs three separate answers,
// not one, and the difference decides whether a hit is a leak at all:
//
//  - the model ECHOED the payload in its reply, which the parser may then have thrown
//    away: noise, or at most a sign the payload held the model's attention;
//  - the payload reached a written SKILL.md, which is the artifact that can be approved
//    and shared: that is the leak the corpus is looking for;
//  - the payload reached grounded-case.json, which is the capture's own record of the
//    session. For a payload planted in an error or a command, the canary is SUPPOSED to
//    be there - that field is the captured evidence - so counting it as a leak would
//    turn a faithful record into a failure.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { candidatesDir } from "../../src/lib/skill-index.js";

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export interface WrittenArtifacts {
  /** every SKILL.md the harvest wrote, concatenated */
  skillMd: string;
  /** every grounded-case.json, concatenated */
  groundedCase: string;
  /** every candidate.json, concatenated */
  meta: string;
}

export function readWrittenArtifacts(home: string): WrittenArtifacts {
  const base = candidatesDir(home);
  let slugs: string[];
  try {
    slugs = readdirSync(base);
  } catch {
    return { skillMd: "", groundedCase: "", meta: "" };
  }
  const parts: WrittenArtifacts = { skillMd: "", groundedCase: "", meta: "" };
  for (const slug of slugs) {
    const dir = join(base, slug);
    parts.skillMd += `${readIfPresent(join(dir, "SKILL.md"))}\n`;
    parts.groundedCase += `${readIfPresent(join(dir, "grounded-case.json"))}\n`;
    parts.meta += `${readIfPresent(join(dir, "candidate.json"))}\n`;
  }
  return parts;
}
