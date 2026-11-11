import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { denialMessage, policyDenial, policyOrigin, teamPolicy } from "../lib/policy.js";

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input?.tool_name) return;
  const policy = teamPolicy();
  if (!policy.rules.length) return;
  const rule = policyDenial(policy.rules, input);
  if (!rule) return;
  const origin = policy.copy ? policyOrigin(policy.copy, rule) : null;
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denialMessage(rule, origin) },
    }),
  );
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
