import { configIsBroken } from "../lib/config.js";
import { loadTeamConfig, saveTeamConfig } from "../lib/init.js";
import { formatServerList, readLocalServers } from "../lib/mcp.js";
import type { McpServerEntry } from "../lib/mcp.js";
import { formatMcpShareResult, publishMcpServer } from "../lib/publish.js";

function usage(): never {
  console.error("usage: mcp.js [<server-name>] [--update]");
  process.exit(2);
}

function find(servers: McpServerEntry[], wanted: string): McpServerEntry | string {
  const exact = servers.find((s) => s.name === wanted);
  if (exact) return exact;
  // Server names are typed by hand from a list this command just printed, and "GitLab"
  // reads as "gitlab" to everyone but a string comparison.
  const loose = servers.filter((s) => s.name.toLowerCase() === wanted.toLowerCase());
  if (loose.length === 1) return loose[0]!;
  return `no MCP server named "${wanted}" is configured here. Available: ${servers.map((s) => s.name).join(", ") || "(none)"}`;
}

function main(): void {
  const args = process.argv.slice(2);
  // The answer to "the team already declares this one": send it as an update to theirs.
  // Nothing else sets it, so an overwrite is always something the publisher asked for
  // after being told, never something this command inferred from a matching name.
  const update = args.includes("--update");
  const names = args.filter((a) => a !== "--update");
  if (names.length > 1 || names[0]?.startsWith("-")) usage();
  const servers = readLocalServers();
  const wanted = names[0];
  if (!wanted) {
    if (update) usage();
    console.log(formatServerList(servers));
    if (!loadTeamConfig()) {
      console.log(
        "\nNo team repository is configured yet, so there is nowhere to share these. " +
          "Run /handbook:init (or /handbook:join <url>) first.",
      );
    }
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
  if (!team) {
    console.error("error: no team repository is configured. Run /handbook:init (or /handbook:join <url>) first.");
    process.exitCode = 1;
    return;
  }
  const entry = find(servers, wanted);
  if (typeof entry === "string") {
    console.error(`error: ${entry}`);
    process.exitCode = 1;
    return;
  }
  const result = publishMcpServer(entry, team, undefined, undefined, update ? { update } : {});
  if (!result.ok) {
    // The library states that the name is taken; the way out of it is spelled here, in this
    // command's own grammar. /handbook:migrate reads the same refusal and answers it with
    // `--update <name>`, so a route named in the library would be wrong in one of the two.
    const taken = result.refused?.some((r) => r.collision && r.name === entry.name);
    console.error(
      taken
        ? `error: ${result.error} Run this again with --update to send yours as an update to theirs, or rename yours.`
        : `error: ${result.error}`,
    );
    process.exitCode = 1;
    return;
  }
  // The forge refused the default branch name and the push recovered under the team's own
  // prefix: remember it, so no later share pays that round trip again.
  if (result.learnedBranchPrefix) {
    saveTeamConfig({ ...team, branchPrefix: result.learnedBranchPrefix });
  }
  console.log(formatMcpShareResult(result, team.marketplaceName));
}

main();
