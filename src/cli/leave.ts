import { clearTeamConfig, loadTeamConfig } from "../lib/init.js";

function main(): void {
  const team = loadTeamConfig();
  if (!team) {
    console.log("No team is configured — nothing to leave. You're already in solo mode.");
    return;
  }
  clearTeamConfig();
  console.log(
    `Left the team skill base at ${team.repoUrl}. TeamHandbook is back in solo mode; approved skills now ` +
      `install into the current project. Run /handbook:join <url> to join a different team.\n` +
      `Claude Code's marketplace subscription is separate — run ` +
      `\`/plugin marketplace remove ${team.marketplaceName}\` yourself if you also want to stop receiving that team's skills.`,
  );
}

main();
