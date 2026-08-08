import { readStdin } from "../lib/hook-io.js";
import { parseLearnPayload, signalFromLearnPayload } from "../lib/learn.js";
import { runManualSignal } from "../lib/pipeline.js";

function describeSieve(reason: string, detail?: string): string {
  if (reason === "secret") {
    return "Dropped: the case contains secret-like content; nothing was stored.";
  }
  if (reason === "oversized") {
    return `Dropped by rule sieve: the ${detail ?? "case"} is too large to distill.`;
  }
  return `Dropped by rule sieve (${reason}${detail ? `: ${detail}` : ""}).`;
}

async function main(): Promise<number> {
  const { payload, error } = parseLearnPayload(await readStdin());
  if (!payload) {
    console.error(`error: ${error}`);
    return 2;
  }
  const signal = signalFromLearnPayload(payload, new Date().toISOString());
  const outcome = await runManualSignal(signal);
  switch (outcome.stage) {
    case "sieved":
      console.log(describeSieve(outcome.reason, outcome.detail));
      return 0;
    case "gate-rejected":
      console.log(
        outcome.duplicateOf
          ? `Gate rejected the candidate as a duplicate of existing skill "${outcome.duplicateOf}".`
          : `Gate rejected the candidate (score ${outcome.total}/10, threshold ${outcome.threshold}).${outcome.rationale ? ` Rationale: ${outcome.rationale}` : ""}`,
      );
      return 0;
    case "error":
      console.error(`error: ${outcome.message}`);
      return 1;
    case "written":
      console.log(
        `Candidate "${outcome.slug}" written (scope: ${outcome.scope}${outcome.gateTotal !== null ? `, gate ${outcome.gateTotal}/10` : ""}). Run /handbook:review to approve or reject it.`,
      );
      return 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${String(err)}`);
    process.exit(1);
  },
);
