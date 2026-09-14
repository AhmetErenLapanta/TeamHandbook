import { configIsBroken } from "../lib/config.js";
import { loadTeamConfig, saveTeamConfig } from "../lib/init.js";
import { formatServerList, readLocalServers } from "../lib/mcp.js";
import type { McpServerEntry } from "../lib/mcp.js";
import { formatMcpShareResult, publishMcpServer } from "../lib/publish.js";

function usage(): never {
  console.error("usage: mcp.js [<server-name>]");
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
  if (args.length > 1 || args[0]?.startsWith("-")) usage();
  const servers = readLocalServers();
  const wanted = args[0];
  if (!wanted) {
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
  const result = publishMcpServer(entry, team);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
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
