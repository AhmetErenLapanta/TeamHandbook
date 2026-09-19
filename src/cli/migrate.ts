import { configIsBroken } from "../lib/config.js";
import { loadTeamConfig, saveTeamConfig } from "../lib/init.js";
import { buildInventory, formatInventory, formatMigrateResult, shareSelection } from "../lib/migrate.js";
import type { Inventory, Selection } from "../lib/migrate.js";
import { teamAssets } from "../lib/publish.js";

function usage(): never {
  console.error(
    "usage: migrate.js [list]\n" +
      "       migrate.js share [--skill <name>]... [--mcp <name>]... [--command <name>]... [--update <name>]...",
  );
  process.exit(2);
}

/**
 * Names are typed back from a list this command just printed, and "GitLab" reads as
 * "gitlab" to everyone but a string comparison. Same allowance /handbook:mcp already
 * makes, for the same reason; an ambiguous match is left unresolved so the run reports it
 * rather than picking one.
 */
function resolve(available: string[], wanted: string): string {
  if (available.includes(wanted)) return wanted;
  const loose = available.filter((name) => name.toLowerCase() === wanted.toLowerCase());
  return loose.length === 1 ? loose[0]! : wanted;
}

const FLAGS = ["--skill", "--mcp", "--command"] as const;

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

/** Every `--update <name>`, resolved against what is installed here the same way the
 * selection flags are, so "GitLab" and "gitlab" name the same server in both places. */
function parseUpdates(args: string[], inv: Inventory): string[] {
  const names: string[] = [];
  const available = [...inv.servers.map((s) => s.name), ...inv.commands.map((c) => c.name)];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== UPDATE) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) usage();
    names.push(resolve(available, value.replace(/^\//, "")));
  }
  return names;
}

function parseSelection(args: string[], inv: Inventory): Selection {
  const selection: Selection = { skills: [], servers: [], commands: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as (typeof FLAGS)[number];
    const value = args[i + 1];
    if (!FLAGS.includes(flag)) continue;
    if (!value || value.startsWith("--")) usage();
    if (flag === "--skill") selection.skills.push(resolve(inv.skills.map((s) => s.name), value));
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
  const selected = args.some((a) => (FLAGS as readonly string[]).includes(a));
  const update = args.includes(UPDATE);
  const [cmd = "list", ...rest] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (rest.length || (cmd !== "list" && cmd !== "share")) usage();
  // A selection passed to the read-only screen would print the list and silently throw
  // the selection away, which reads as "I asked for four and got none".
  if (cmd === "list" && (selected || update)) usage();
  if (cmd === "list") {
    // The one network call this screen makes, and only when there is a repository to ask.
    // What comes back is a label: buildInventory marks the names the team already has so
    // the manager picks knowing, and a repository that cannot be reached simply means no
    // labels rather than a screen that will not open.
    const config = loadTeamConfig();
    console.log(formatInventory(buildInventory({}, config ? teamAssets(config) : null)));
    if (!config) {
      console.log(
        "\nNo team repository is configured yet. Skills can still be queued for review, but the " +
          "MCP servers and commands have nowhere to go: run /handbook:init (or /handbook:join <url>) first.",
      );
    }
    return;
  }
  const inv = buildInventory();
  const selection = parseSelection(args, inv);
  const updates = parseUpdates(args, inv);
  // The point of the card, in one branch: nothing is selected by default, so a share with
  // no flags shares nothing rather than everything.
  if (!selection.skills.length && !selection.servers.length && !selection.commands.length) {
    console.log("Nothing was selected, so nothing was queued and nothing was shared.");
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
  const result = shareSelection(selection, team, {}, undefined, undefined, updates.length ? { update: updates } : {});
  // The forge refused the default branch name and the push recovered under the team's own
  // prefix: remember it, so no later share pays that round trip again.
  if (team && result.team?.learnedBranchPrefix) {
    saveTeamConfig({ ...team, branchPrefix: result.team.learnedBranchPrefix });
  }
  console.log(formatMigrateResult(result, team?.marketplaceName));
  // A refusal is not a crash: some of the selection may have travelled. The exit code says
  // "not everything you asked for happened", and the text above says which part.
  if (result.refused.length) process.exitCode = 1;
}

main();
