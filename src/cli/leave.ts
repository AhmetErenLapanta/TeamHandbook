import { clearTeamConfig, loadTeamConfig } from "../lib/init.js";
import { configIsBroken } from "../lib/config.js";

function main(): void {
  // A broken config reads as "no team" — saying "you're already in solo mode" would
  // be a guess presented as fact, and the file may well hold a team binding.
  if (configIsBroken()) {
    console.error(
      "error: ~/.teamhandbook/config.json is not valid JSON, so TeamHandbook cannot tell " +
        "whether a team is configured — and will not rewrite the file and risk " +
        "discarding settings you wrote. Fix the JSON (or delete the file) and try again.",
    );
    process.exitCode = 1;
    return;
  }
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
