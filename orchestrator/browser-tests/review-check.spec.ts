import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { stateFor } from "./roles.js";

// The suite's orchestrator serves the demo's local repositories, which have no GitHub or GitLab
// access to write a check with: turning the check on there is refused, and it stays off.

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  return { "x-csrf-token": (await (await request.get("/api/me")).json()).csrf, "content-type": "application/json" };
}

test("given a repository with no forge access, when an admin turns its review check on, then it is refused with the reason and the check stays off", async ({ request }) => {
  // given
  const before = await (await request.get("/api/repos/payments-skills/review-check")).json();
  expect(before).toEqual({ check: null, rulesFile: ".teamhandbook/review-rules.md", context: "teamhandbook/review-rules" });

  // when
  const res = await request.put("/api/repos/payments-skills/review-check", { data: { agent: "fake" }, headers: await csrf(request) });

  // then
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toContain("has no forge access set, so a check has nowhere to be written");
  expect((await (await request.get("/api/repos/payments-skills/review-check")).json()).check).toBeNull();
});

test.describe("a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member, when they turn a repository's review check on, then it is refused", async ({ request }) => {
    const res = await request.put("/api/repos/payments-skills/review-check", { data: { agent: "fake" }, headers: await csrf(request) });
    expect(res.status()).toBe(403);
  });
});
