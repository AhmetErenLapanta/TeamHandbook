import { readStdin } from "../lib/hook-io.js";
import { parseLearnPayload, signalFromLearnPayload } from "../lib/learn.js";
import { runManualSignal } from "../lib/pipeline.js";

function describeSieve(reason: string, detail?: string): string {
  if (reason === "secret") {
    return "Dropped: the case contains secret-like content; nothing was stored.";
  }
  if (reason === "oversized") {
    return `Dropped by rule sieve: too large to distill (${detail ?? "case"}).`;
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
    case "error":
      console.error(
        `error: ${outcome.message}${/doctor/.test(outcome.message) ? "" : " — run /handbook:doctor to diagnose"}`,
      );
      return 1;
    case "written": {
      const advice: string[] = [];
      if (outcome.belowThreshold) {
        advice.push(
          `scored it ${outcome.gateTotal ?? "?"}/10, below the ${outcome.threshold}/10 threshold` +
            (outcome.rationale ? ` (${outcome.rationale})` : ""),
        );
      }
      if (outcome.duplicateOf) {
        advice.push(`thinks it duplicates existing skill "${outcome.duplicateOf}"`);
      }
      if (advice.length > 0) {
        console.log(
          `Candidate "${outcome.slug}" written (scope: ${outcome.scope}). The gate ${advice.join(" and ")}. ` +
            `It is queued anyway because you asked for it — the publish decision is yours in /handbook:review.`,
        );
      } else {
        console.log(
          `Candidate "${outcome.slug}" written (scope: ${outcome.scope}${outcome.gateTotal !== null ? `, gate ${outcome.gateTotal}/10` : ""}). Run /handbook:review to approve or reject it.`,
        );
      }
      return 0;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${String(err)}`);
    process.exit(1);
  },
);
