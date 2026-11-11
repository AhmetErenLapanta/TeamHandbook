import { describe, expect, it } from "vitest";
import { serverProblem } from "./skill-rules.js";

describe("a tracker server's credential as the README declares it", () => {
  it("given the header as a whole reference and as a reference after a scheme word, when each is held to the share rule, then the first travels and the second is refused as a literal value", () => {
    // given
    const server = (authorization: string) => ({ type: "http", url: "https://tracker.example.com/mcp", headers: { Authorization: authorization } });

    // when
    const whole = serverProblem("tracker", server("${TRACKER_AUTHORIZATION}"));
    const inside = serverProblem("tracker", server("Bearer ${TRACKER_TOKEN}"));

    // then
    expect("audit" in whole && whole.audit.requiresEnv).toEqual(["TRACKER_AUTHORIZATION"]);
    expect(inside).toEqual({ refused: expect.stringContaining("tracker is not shareable as written: headers.Authorization holds a literal value") });
  });
});
