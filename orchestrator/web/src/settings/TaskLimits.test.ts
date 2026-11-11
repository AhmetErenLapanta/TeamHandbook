import { describe, expect, it } from "vitest";
import { limitsLine, limitsSaid } from "./TaskLimits";

describe("what saved task limits say", () => {
  it("given both limits, one, the other or neither, when they are saved, then the sentence names each limit that holds and says which has none", () => {
    // when
    const said = [
      limitsSaid({ maxUsd: 10, maxMinutes: 60 }),
      limitsSaid({ maxUsd: 2.5, maxMinutes: null }),
      limitsSaid({ maxUsd: null, maxMinutes: 90 }),
      limitsSaid({ maxUsd: null, maxMinutes: null }),
    ];

    // then
    expect(said).toEqual([
      "A task now stops at $10.00 or after 60 minutes, whichever comes first.",
      "A task now stops at $2.50; how long it runs has no limit.",
      "A task now stops after 90 minutes; what it spends has no limit.",
      "A task now has no limit on what it spends or how long it runs.",
    ]);
  });
});

describe("what the limits say before a task starts", () => {
  it("given both limits, one, the other or neither, when the line is made, then it names each limit that holds and says which has none", () => {
    // when
    const said = [
      limitsLine({ maxUsd: 10, maxMinutes: 60 }),
      limitsLine({ maxUsd: 2.5, maxMinutes: null }),
      limitsLine({ maxUsd: null, maxMinutes: 90 }),
      limitsLine({ maxUsd: null, maxMinutes: null }),
    ];

    // then
    expect(said).toEqual([
      "A task stops at $10.00 or after 60 minutes, whichever comes first.",
      "A task stops at $2.50; how long it runs has no limit.",
      "A task stops after 90 minutes; what it spends has no limit.",
      "A task has no limit on what it spends or how long it runs.",
    ]);
  });
});
