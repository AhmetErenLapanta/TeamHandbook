import { turnKey } from "./git.js";
import { buildOverlapIndex } from "./plugin.js";

/** How many repositories' answers are kept; a new head of one replaces its old answer. */
const KEPT = 32;

const answers = new Map<string, Promise<Record<string, SkillOverlap>>>();

/** The most skills one skill's answer names; the rest are counted. */
const NAMED = 10;

/** The skills that answer the same requests as one skill, most overlapping first, and how many past those. */
export interface SkillOverlap {
  names: string[];
  more: number;
}

/** The longest the work holds the event loop before letting other requests in. */
const SLICE_MS = 10;

/**
 * Which skills of a repository answer the same requests, by the plugin's own measure, worked
 * out once for each head. It is spread out in slices: worked out in one go over 2000 skills it
 * held the orchestrator for seconds, and no other request - a sign-in, a teammate's skill-use counts -
 * was answered until it ended.
 */
export function skillOverlaps(mirror: string, head: string, skills: () => Promise<readonly { slug: string; description: string }[]>): Promise<Record<string, SkillOverlap>> {
  const repository = turnKey(mirror);
  const key = `${repository}@${head}`;
  const known = answers.get(key);
  if (known) return known;
  for (const old of answers.keys()) if (old.startsWith(`${repository}@`)) answers.delete(old);
  const answer = skills().then(workOut);
  answers.set(key, answer);
  answer.catch(() => answers.delete(key));
  while (answers.size > KEPT) answers.delete(answers.keys().next().value!);
  return answer;
}

/** The plugin's index over `described`, built a slice at a time, and the pause it used. */
async function slicedIndex(described: { name: string; description: string }[]) {
  let started = performance.now();
  const pause = async () => {
    if (performance.now() - started <= SLICE_MS) return;
    await new Promise((resolve) => setImmediate(resolve));
    started = performance.now();
  };
  const steps = buildOverlapIndex(described);
  let step = steps.next();
  while (!step.done) {
    await pause();
    step = steps.next();
  }
  return { find: step.value, pause };
}

const answerOf = (names: string[]): SkillOverlap => ({ names: names.slice(0, NAMED), more: Math.max(0, names.length - NAMED) });

async function workOut(skills: readonly { slug: string; description: string }[]): Promise<Record<string, SkillOverlap>> {
  const described = skills.filter((s) => s.description).map((s) => ({ name: s.slug, description: s.description }));
  const { find, pause } = await slicedIndex(described);
  const found: Record<string, SkillOverlap> = {};
  for (const skill of described) {
    found[skill.name] = answerOf(find(skill));
    await pause();
  }
  return found;
}

/** The skills of a repository a skill's own text overlaps, as a change would leave it: the skill's current text is not among them. */
export async function overlapsOfText(skills: readonly { slug: string; description: string }[], candidate: { slug: string; description: string }): Promise<SkillOverlap> {
  const described = skills.filter((s) => s.description && s.slug !== candidate.slug).map((s) => ({ name: s.slug, description: s.description }));
  const { find } = await slicedIndex(described);
  return answerOf(find({ name: candidate.slug, description: candidate.description }));
}
