import { configIsBroken } from "../lib/config.js";
import { formatInitSuccess, initTeamRepo, loadTeamConfig } from "../lib/init.js";
import type { CommitMessageChoice } from "../lib/init.js";
import { applyUpgrade, formatUpgradePlan, formatUpgradeResult, planUpgrade } from "../lib/upgrade.js";

function usage(): never {
  console.error(
    "usage: init.js <git-url> [--name <marketplace-name>] [--branch-prefix <prefix>] [--commit-prefix <prefix>] " +
      "[--with-ci] [--message <commit message>] [--delegate-message <fingerprint>]\n" +
      "       init.js --upgrade [--file <scaffold-path>]... [--message <commit message>] [--delegate-message <fingerprint>]",
  );
  process.exit(2);
}

/**
 * What the user decided the commit should say, read off the command line.
 *
 * Both halves of this command commit, so both read it the same way. An empty object is
 * the honest reading of "they were never asked", and every path that commits refuses on
 * it rather than writing its own sentence into the team's repository.
 */
function valueOf(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function commitMessageFrom(args: string[]): CommitMessageChoice {
  const message = valueOf(args, "--message");
  const delegated = valueOf(args, "--delegate-message");
  return {
    ...(message !== undefined ? { message } : {}),
    ...(delegated !== undefined ? { delegated } : {}),
  };
}

/**
 * Refreshing the scaffold of the repository already configured, rather than scaffolding a
 * new one. It lives behind the same command because it is the same object and the same
 * write path: the wall it removes is init's own refusal to run against a configured team.
 *
 * Two calls, and the split is the approval. With no `--file` this prints what would
 * change and writes nothing, anywhere. Each `--file` names one scaffold file to send, so
 * a file the team edited by hand is kept by not being named.
 */
function upgrade(args: string[]): void {
  const files: string[] = [];
  const commitMessage = commitMessageFrom(args);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--upgrade") continue;
    // Both take a value, which is read above: stepping over it here is what keeps the
    // fingerprint from being read as a --file path.
    if (args[i] === "--message" || args[i] === "--delegate-message") {
      i++;
      continue;
    }
    if (args[i] !== "--file") usage();
    const value = args[++i];
    if (!value || value.startsWith("--")) usage();
    files.push(value);
  }
  if (configIsBroken()) {
    console.error(
      "error: TeamHandbook's config.json is not valid JSON, so it cannot tell which repository " +
        "your team uses. Fix the JSON (or delete the file) and try again.",
    );
    process.exit(1);
  }
  const team = loadTeamConfig();
  if (!team) {
    console.error(
      "error: no team repository is configured, so there is no scaffold to refresh. " +
        "Run /handbook:init <url> to create one, or /handbook:join <url> to point at your team's.",
    );
    process.exit(1);
  }
  if (!files.length) {
    const plan = planUpgrade(team);
    if (!plan.ok) {
      console.error(`error: ${plan.error}`);
      process.exit(1);
    }
    console.log(formatUpgradePlan(plan));
    return;
  }
  const result = applyUpgrade(team, files, undefined, undefined, commitMessage);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatUpgradeResult(result));
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--upgrade")) return upgrade(args);
  let url: string | undefined;
  let name: string | undefined;
  let branchPrefix: string | undefined;
  let commitPrefix: string | undefined;
  let withCi = false;
  const commitMessage = commitMessageFrom(args);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--message" || args[i] === "--delegate-message") {
      // read already, and its value stepped over so it is not mistaken for the URL
      i++;
    } else if (args[i] === "--name") {
      name = args[++i];
      if (!name) usage();
    } else if (args[i] === "--branch-prefix") {
      branchPrefix = args[++i];
      if (!branchPrefix) usage();
    } else if (args[i] === "--commit-prefix") {
      commitPrefix = args[++i];
      if (!commitPrefix) usage();
    } else if (args[i] === "--with-ci") {
      withCi = true;
    } else if (!url) {
      url = args[i];
    } else {
      usage();
    }
  }
  if (!url) usage();
  const result = initTeamRepo(
    url,
    name,
    undefined,
    undefined,
    undefined,
    undefined,
    branchPrefix,
    commitPrefix,
    withCi,
    commitMessage,
  );
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatInitSuccess(result));
}

main();
