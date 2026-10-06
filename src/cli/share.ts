import { resolve as toAbsolutePath } from "node:path";
import { configIsBroken } from "../lib/config.js";
import { join } from "node:path";
import { loadTeamConfig, marketplacesRoot, runGit } from "../lib/init.js";
import {
  buildInventory,
  duplicateCopies,
  forgeLine,
  formatInventory,
  formatPick,
  formatShareResult,
  pickByPattern,
  shareSelection,
} from "../lib/share.js";
import type { Duplicates, Inventory, Selection } from "../lib/share.js";
import { teamAssets } from "../lib/publish.js";
import type { CommitMessageChoice, TeamConfig } from "../lib/init.js";
import { branchHints } from "../lib/branch.js";

/** The copies of this machine's own setup the team plugin here already carries word for word. */
function duplicatesOf(inv: Inventory, team: TeamConfig | null): Duplicates | undefined {
  return team ? duplicateCopies(inv, join(marketplacesRoot(), team.marketplaceName)) : undefined;
}

function usage(): never {
  console.error(
    "usage: share.js [list]\n" +
      '       share.js pick "<names or patterns>"\n' +
      "       share.js share [--skill <name>]... [--skill-path <dir>]... [--mcp <name>]... " +
      "[--command <name>]... [--update <name>]... (--message <commit message> | --delegate-message <fingerprint>) " +
      "--branch <name> [--branch-hint <name>] [--version-after-open]",
  );
  process.exit(2);
}

/**
 * Names are typed back from a list this command just printed, and "GitLab" reads as
 * "gitlab" to everyone but a string comparison. An ambiguous match is left unresolved so
 * the run reports it rather than picking one.
 */
function resolve(available: string[], wanted: string): string {
  if (available.includes(wanted)) return wanted;
  const loose = available.filter((name) => name.toLowerCase() === wanted.toLowerCase());
  return loose.length === 1 ? loose[0]! : wanted;
}

const FLAGS = ["--skill", "--mcp", "--command"] as const;

/**
 * The one selection that is not a name off the screen.
 *
 * The screen lists the two directories Claude Code loads skills from, so a skill authored
 * anywhere else has no entry to pick. The single-skill command this replaced took a path
 * and only a path, so dropping it would have taken a working route away from anyone
 * scripting against it; it is kept, and unlike before it is in the usage line.
 */
const SKILL_PATH = "--skill-path";

/**
 * Sending an update to what the team already has, rather than being turned back for it.
 *
 * It NAMES what it updates, like every other flag here. A bare flag applying to the whole
 * selection was the first shape and it was wrong for the same reason `approve --all
 * --update` is wrong: a publisher shown two refusals and consenting to one of them would
 * have had the other replaced by the same word. In this command consent is per item because
 * the selection is per item, and the boundary belongs in code - a sentence in the markdown
 * telling the agent to be careful is not a boundary.
 */
const UPDATE = "--update";

/**
 * What the commit on the merge request says.
 *
 * `--message` carries the wording the user saw and approved; `--delegate-message` is the
 * one other answer they can give, "you decide", and it names the fingerprint of the
 * proposal they were shown - the run that refused printed both. A share with neither is
 * refused before anything is committed: the message on a request other people read is the
 * user's to write.
 */
const MESSAGE = "--message";
const DELEGATE_MESSAGE = "--delegate-message";

/**
 * The branch the request goes out on, the other half of the one question asked before
 * every push. `--branch` is used exactly as given and is never written anywhere: it names
 * this request, not every request after it. `--branch-hint` is a branch the user named
 * earlier in this session, which only lends its ticket key to the proposal.
 * `--version-after-open` is the answer to an unmerged branch already claiming the version
 * this request would raise to.
 */
const BRANCH = "--branch";
const BRANCH_HINT = "--branch-hint";
const VERSION_AFTER_OPEN = "--version-after-open";

/** Every flag that swallows the argument after it, so the positional reader below knows
 * which bare words are values and which are the command. All of them take one, including
 * `--delegate-message`, whose value is the fingerprint of the proposal the user was shown.
 * The cost of that is real and it is caught rather than avoided: `--delegate-message share
 * --skill x` eats the word `share`, the command falls back to `list`, and the guard below
 * sends a `list` carrying message flags to the usage line rather than silently printing an
 * inventory. A fingerprint that is not one is refused in the library besides. */
const VALUE_FLAGS: readonly string[] = [...FLAGS, SKILL_PATH, UPDATE, MESSAGE, DELEGATE_MESSAGE, BRANCH, BRANCH_HINT];

/** The value behind a flag, refused rather than guessed at when it is missing. */
function valueOf(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function parseCommitMessage(args: string[]): CommitMessageChoice {
  const message = valueOf(args, MESSAGE);
  const delegated = valueOf(args, DELEGATE_MESSAGE);
  return {
    ...(message !== undefined ? { message } : {}),
    ...(delegated !== undefined ? { delegated } : {}),
  };
}

/** Every `--update <name>`, resolved against what is installed here the same way the
 * selection flags are, so "GitLab" and "gitlab" name the same server in both places. */
function parseUpdates(args: string[], inv: Inventory): string[] {
  const names: string[] = [];
  // Skills are here too now that they collide in the team repository like the rest: an
  // update named "Add-Endpoint" has to resolve to add-endpoint the same way "GitLab" does.
  const available = [
    ...inv.skills.map((s) => s.name),
    ...inv.servers.map((s) => s.name),
    ...inv.commands.map((c) => c.name),
  ];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== UPDATE) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) usage();
    names.push(resolve(available, value.replace(/^\//, "")));
  }
  return names;
}

function parseSelection(args: string[], inv: Inventory): Selection {
  const selection: Selection = { skills: [], servers: [], commands: [], skillPaths: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as (typeof FLAGS)[number] | typeof SKILL_PATH;
    const value = args[i + 1];
    if (!FLAGS.includes(flag as (typeof FLAGS)[number]) && flag !== SKILL_PATH) continue;
    if (!value || value.startsWith("--")) usage();
    // Made absolute here rather than in the library, so a relative path means what it
    // means to the shell that typed it.
    if (flag === SKILL_PATH) selection.skillPaths!.push(toAbsolutePath(value));
    else if (flag === "--skill") selection.skills.push(resolve(inv.skills.map((s) => s.name), value));
    else if (flag === "--mcp") selection.servers.push(resolve(inv.servers.map((s) => s.name), value));
    // A command is listed and typed as /explain, so a leading slash is taken off rather
    // than turned into a name nothing on this machine answers to.
    else selection.commands.push(resolve(inv.commands.map((c) => c.name), value.replace(/^\//, "")));
    i++;
  }
  return selection;
}

function main(): void {
  const args = process.argv.slice(2);
  const selected = args.some((a) => (FLAGS as readonly string[]).includes(a) || a === SKILL_PATH);
  const update = args.includes(UPDATE);
  const messaged = [MESSAGE, DELEGATE_MESSAGE, BRANCH, BRANCH_HINT, VERSION_AFTER_OPEN].some((flag) => args.includes(flag));
  const [cmd = "list", ...rest] = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1] ?? ""));
  if (cmd === "pick") {
    // Read-only, like the list: it resolves what the person typed against this machine and
    // prints the names and the one command that shares them. The share itself stays a run
    // of explicit names, so what a pattern matched is seen before anything is committed.
    if (!rest.length || selected || update || messaged) usage();
    const picked = pickByPattern(buildInventory(), rest.join(" "));
    if ("error" in picked) {
      console.error(`error: ${picked.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(formatPick(picked));
    return;
  }
  if (rest.length || (cmd !== "list" && cmd !== "share")) usage();
  // A selection passed to the read-only screen would print the list and silently throw
  // the selection away, which reads as "I asked for four and got none". A commit message
  // is thrown away the same way, and by the screen that shares nothing at all.
  if (cmd === "list" && (selected || update || messaged)) usage();
  if (cmd === "list") {
    // The one network call this screen makes, and only when there is a repository to ask.
    // What comes back is a label: buildInventory marks the names the team already has so
    // the manager picks knowing, and a repository that cannot be reached simply means no
    // labels rather than a screen that will not open.
    const config = loadTeamConfig();
    const inv = buildInventory({}, config ? teamAssets(config) : null);
    console.log(formatInventory(inv, forgeLine(config), duplicatesOf(inv, config)));
    if (!config) {
      console.log(
        "\nNo team repository is configured yet, so nothing on this screen has anywhere to go: " +
          "run /handbook:init (or /handbook:join <url>) first.",
      );
    }
    return;
  }
  const inv = buildInventory();
  const selection = parseSelection(args, inv);
  const updates = parseUpdates(args, inv);
  // The point, in one branch: nothing is selected by default, so a share with
  // no flags shares nothing rather than everything.
  if (!selection.skills.length && !selection.skillPaths!.length && !selection.servers.length && !selection.commands.length) {
    console.log("Nothing was selected, so nothing was shared.");
    return;
  }
  if (configIsBroken()) {
    console.error(
      "error: ~/.teamhandbook/config.json is not valid JSON, so TeamHandbook cannot tell which " +
        "repository your team uses. Fix the JSON (or delete the file) and try again.",
    );
    process.exitCode = 1;
    return;
  }
  const team = loadTeamConfig();
  const branch = valueOf(args, BRANCH);
  const result = shareSelection(selection, team, {}, undefined, undefined, {
    ...(updates.length ? { update: updates } : {}),
    commitMessage: parseCommitMessage(args),
    ...(branch !== undefined ? { branch } : {}),
    hints: branchHints(process.cwd(), runGit, valueOf(args, BRANCH_HINT)),
    ...(args.includes(VERSION_AFTER_OPEN) ? { versionAfterOpen: true } : {}),
  });
  console.log(formatShareResult(result, team?.marketplaceName, duplicatesOf(inv, team)));
  // A refusal is not a crash: some of the selection may have travelled. The exit code says
  // "not everything you asked for happened", and the text above says which part. A request
  // that stopped for want of a commit message refuses no item by name, so it is read off
  // the request itself rather than off a list it never added anything to.
  if (result.refused.length || (result.team && !result.team.ok)) process.exitCode = 1;
}

main();
