import { describe, expect, it } from "vitest";
import { plainFailure } from "./plain-failure.js";

describe("a failed task's reason in a person's words", () => {
  it("given the shapes tools fail in and one this does not know, when each is read, then each known one says what happened and what to do, and the unknown one reads as the tool said it", () => {
    // given
    const raw = [
      "git push failed: fatal: could not read Username for 'https://gitlab.example.invalid': terminal prompts disabled",
      "git fetch failed: ERROR: Repository not found.",
      "git push failed: ! [rejected] task/x -> task/x (non-fast-forward)",
      "connect ECONNREFUSED 127.0.0.1:443",
      "spawn claude ENOENT",
      "ENOSPC: no space left on device, write",
      "The agent reported something unusual.",
    ];

    // when
    const read = raw.map(plainFailure);

    // then
    expect(read.slice(0, 6).every((r, i) => r !== raw[i] && /start the task again/i.test(r))).toBe(true);
    expect(read[0]).toBe("The forge asked for a sign-in this orchestrator does not have. Connect the repository's forge under Integrations, then start the task again.");
    expect(read[4]).toBe("A program the task runs is not installed on this machine, or not on its PATH. Install it, then start the task again.");
    expect(read[6]).toBe("The agent reported something unusual.");
  });
});
