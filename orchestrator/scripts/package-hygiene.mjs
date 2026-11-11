// What a package must not carry out of the machine that built it: the build's own directory or the
// builder's home, which the single executable once kept as its main script's name, and files that
// are the repository's own rather than the product's (tests, source maps, env files, internal notes).
// Both builds refuse an output with any of them, on a developer's machine and on every release runner.
import { homedir } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// A file under any hidden directory belongs to a working directory (version control, an editor, a
// cache, notes), never to the product.
const INTERNAL = /(^|\/)\.[^/]+\/|(^|\/)(\.env(\..*)?|CLAUDE\.md|AGENTS\.md|\.DS_Store|\._[^/]*)$|\.(test|spec)\.[cm]?[jt]sx?$|\.map$/;

/** Every file under `dir` that is the repository's own, or holds one of `places`, as "<file>: <why>". */
export function packageLeaks(dir, places) {
  const needles = [...new Set(places.filter((p) => p && p.length > 4))].map((p) => [p, Buffer.from(p)]);
  const leaks = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name);
    const name = relative(dir, file);
    if (INTERNAL.test(name)) leaks.push(`${name}: a repository file, not the product's`);
    const bytes = readFileSync(file);
    for (const [place, needle] of needles) if (bytes.includes(needle)) leaks.push(`${name}: carries ${place}`);
  }
  return leaks;
}

/** The places a build on this machine must not leave in what it packs. */
export function buildPlaces(repoRoot) {
  return [repoRoot, homedir()];
}
