import { configIsBroken } from "../lib/config.js";
import { loadTeamConfig, saveTeamConfig } from "../lib/init.js";
import { buildInventory, formatInventory, formatMigrateResult, shareSelection } from "../lib/migrate.js";
import type { Inventory, Selection } from "../lib/migrate.js";

function usage(): never {
  console.error("usage: migrate.js [list]\n       migrate.js share [--skill <name>]... [--mcp <name>]...");
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

function parseSelection(args: string[], inv: Inventory): Selection {
  const selection: Selection = { skills: [], servers: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== "--skill" && flag !== "--mcp") continue;
    if (!value || value.startsWith("--")) usage();
    if (flag === "--skill") selection.skills.push(resolve(inv.skills.map((s) => s.name), value));
    else selection.servers.push(resolve(inv.servers.map((s) => s.name), value));
    i++;
  }
  return selection;
}

function main(): void {
  const args = process.argv.slice(2);
  const selected = args.some((a) => a === "--skill" || a === "--mcp");
  const [cmd = "list", ...rest] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (rest.length || (cmd !== "list" && cmd !== "share")) usage();
  // A selection passed to the read-only screen would print the list and silently throw
  // the selection away, which reads as "I asked for four and got none".
  if (cmd === "list" && selected) usage();
  const inv = buildInventory();
  if (cmd === "list") {
    console.log(formatInventory(inv));
    if (!loadTeamConfig()) {
      console.log(
        "\nNo team repository is configured yet. Skills can still be queued for review, but the " +
          "MCP servers have nowhere to go: run /handbook:init (or /handbook:join <url>) first.",
      );
    }
    return;
  }
  const selection = parseSelection(args, inv);
  // The point of the card, in one branch: nothing is selected by default, so a share with
  // no flags shares nothing rather than everything.
  if (!selection.skills.length && !selection.servers.length) {
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
  const result = shareSelection(selection, team);
  // The forge refused the default branch name and the push recovered under the team's own
  // prefix: remember it, so no later share pays that round trip again.
  if (team && result.mcp?.learnedBranchPrefix) {
    saveTeamConfig({ ...team, branchPrefix: result.mcp.learnedBranchPrefix });
  }
  console.log(formatMigrateResult(result, team?.marketplaceName));
  // A refusal is not a crash: some of the selection may have travelled. The exit code says
  // "not everything you asked for happened", and the text above says which part.
  if (result.refused.length) process.exitCode = 1;
}

main();
