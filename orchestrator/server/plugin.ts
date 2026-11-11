// The only door from the orchestrator into the plugin's own code. The plugin's modules were written
// for one developer's machine: several default their state directory to the account's home
// (`handbookHome()`, `homedir()`), and a server importing one of those by accident would read
// or write a real ~/.teamhandbook on whatever host runs it. Everything here is a pure function
// over values the orchestrator hands in, so the orchestrator reuses the plugin's rules - how a skill's
// frontmatter is read, which MCP definitions may travel, what a secret looks like - without
// inheriting its idea of where a home is. The one exception, task-lesson, writes into a review
// queue, and every function of it takes that queue's home as an argument it does not default: a
// local orchestrator names its person's own. guard.test.ts fails if anything else is imported.
export { parseSkillFrontmatter } from "../../src/lib/skill-index.js";
export type { SkillSummary } from "../../src/lib/skill-index.js";
export { auditServer, declaredServers, mergeServersIntoMcpJson, refusalSummary, urlToken } from "../../src/lib/mcp.js";
export type { McpAudit, McpRefusal } from "../../src/lib/mcp.js";
export { detectSecret } from "../../src/lib/secrets.js";
export { buildInventory } from "../../src/lib/share.js";
export type { InventoryPaths } from "../../src/lib/share.js";
export { auditSkillDir } from "../../src/lib/queue.js";
export { auditCommand } from "../../src/lib/commands.js";
export {
  assertSafeGitUrl,
  commitMessagePrefix,
  commitMessageProblem,
  commitPrefixProblem,
  commitSubject,
  DEFAULT_BRANCH_PREFIX,
  hostFromUrl,
  nonInteractiveEnv,
  README_BEGIN,
  README_END,
  SCAFFOLD_COMMIT_TITLE,
  skeletonFiles,
  TEAM_PREFIX_FILE,
} from "../../src/lib/init.js";
export { PLUGIN_MANIFEST, MARKETPLACE_MANIFEST, REFRESH_COMMIT_TITLE, scaffoldVersionProblem, upgradeCandidates } from "../../src/lib/upgrade.js";
export type { CandidateSet } from "../../src/lib/upgrade.js";
export { marketplaceNameProblem } from "../../src/lib/join.js";
export { auditCommandText, commandDescription, commandFile } from "../../src/lib/commands.js";
export type { CommandAudit } from "../../src/lib/commands.js";
export { assignmentRecordProblem, branchExampleProblem, branchTrace, compareVersions, proposeBranch, versionPast } from "../../src/lib/branch.js";
export type { VersionClaim } from "../../src/lib/branch.js";
export { checkSkillFormat, MAX_BODY_LINES, MAX_DESC, MAX_LISTING, MAX_NAME, MIN_STEPS, MIN_TRIGGER_SENTENCES, MIN_VERIFY_ITEMS } from "../../src/lib/skill-format.js";
export { buildOverlapIndex, overlapIndex } from "../../src/lib/skill-health.js";
export { claudeDenyRules, mcpToolPart, patternMatches, policiesProblem, policyDenial, POLICY_ACTIONS, POLICY_MAX_RESOURCES, POLICY_MAX_RULES, POLICY_NAME_MAX, POLICY_REASON_MAX, policyRules, ruleProblem } from "../../src/lib/policy.js";
export type { PolicyAction, PolicyRule, TeamFilePolicy } from "../../src/lib/policy.js";
export { hostIdentityOf, keepTaskLesson, queueTaskLesson, readTaskLessonReply, readTaskLessonWire, rejectTaskLesson, signalIsSafe, taskLesson, taskLessonCandidate, taskLessons } from "../../src/lib/task-lesson.js";
export type { CandidateMeta, TaskLessonSignal, TaskLessonWire } from "../../src/lib/task-lesson.js";
