import { expect, test } from "@playwright/test";

// An open request's line on a repository's Requests, from stand-in answers: the orchestrator's own
// requests on GitLab, one ready, one held, one the forge did not answer for, and one on this
// machine's own copy.

/** A status as the forge's read answers it, with what people said on the request. */
const onForge = (detail: Record<string, unknown>, comments: Record<string, unknown>[] = []) => ({ status: { source: "forge", capabilities: null, detail, comments, fingerprint: "f" } });

const request = (number: number, title: string) => ({ repoId: "payments-skills", number, url: `https://gitlab.example/acme/payments-skills/-/merge_requests/${number}`, branch: `handbook/orchestrator-${number}`, title, status: "open", provider: "gitlab", createdAt: "2026-11-02T10:00:00Z", createdBy: "ada@example.invalid" });

test("given open requests on a forge, when the Requests page opens, then each says in one line whether its checks pass, who reviewed it and whether it merges", async ({ page }) => {
  // given
  await page.route((url) => url.pathname === "/api/requests", (route) =>
    route.fulfill({ json: { requests: [request(21, "Ready one"), request(22, "Held one"), request(23, "Unread one")], total: 3, counts: { open: 3, merged: 0, closed: 0 }, pageSize: 50, next: null } }),
  );
  await page.route("**/api/repos/payments-skills/requests/*/status", (route) => {
    const number = Number(new URL(route.request().url()).pathname.split("/").at(-2));
    if (number === 21) return route.fulfill({ json: onForge({ number, status: "open", headSha: "a1", checks: { state: "passing", checks: [] }, review: { decision: "approved", approvedBy: ["grace"] }, mergeability: { state: "mergeable", reason: null } }, [{ id: "c1", author: "grace", kind: "person", body: "Looks right.", at: "2026-11-02T11:00:00Z", path: null, line: null, url: null }]) });
    if (number === 22) return route.fulfill({ json: onForge({ number, status: "open", headSha: "b2", checks: { state: "failing", checks: [{ name: "lint", group: "pipeline", state: "failure", url: null }, { name: "unit", group: "pipeline", state: "failure", url: null }, { name: "build", group: "pipeline", state: "success", url: null }] }, review: { decision: "changes-requested", approvedBy: [] }, mergeability: { state: "blocked", reason: "the pipeline must succeed" } }) });
    return route.fulfill({ status: 502, json: { error: "GitLab did not answer in 10 seconds" } });
  });

  // when
  await page.goto("/demo/repositories/payments-skills/requests");

  // then
  await expect(page.getByRole("row", { name: /Ready one/ })).toContainText("ready to merge checks passing, approved by grace, 1 comment, the newest from grace");
  await expect(page.getByRole("row", { name: /Held one/ })).toContainText("blocked: the pipeline must succeed 2 checks failing, changes requested");
  await expect(page.getByRole("row", { name: /Unread one/ })).toContainText("Where it stands is not known: GitLab did not answer in 10 seconds");
});

test("given a teammate's request waiting on the forge, when the repository's Requests tab opens, then its forge line sits beside what reading it found", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/pending", (route) =>
    route.fulfill({ json: { pending: [{ number: 31, title: "Share a release skill", branch: "share/31", url: "https://gitlab.example/acme/payments-skills/-/merge_requests/31", author: "lin@example.invalid", updatedAt: "2026-11-02T10:00:00Z", fromFork: false, byOrchestrator: false, scan: { state: "clean", head: "c3", findings: [] } }] } }),
  );
  await page.route("**/api/repos/payments-skills/requests/31/status", (route) =>
    route.fulfill({ json: onForge({ number: 31, status: "open", headSha: "c3", checks: { state: "pending", checks: [] }, review: { decision: "pending", approvedBy: [] }, mergeability: { state: "conflict", reason: null } }) }),
  );

  // when
  await page.goto("/demo/repositories/payments-skills/requests");

  // then
  const row = page.getByRole("region", { name: /^Waiting to be merged/ }).getByRole("row", { name: /Share a release skill/ });
  await expect(row).toContainText("nothing unusual");
  await expect(row).toContainText("has a conflict to resolve checks running, waiting for a reviewer");
});

test("given an open request on this machine's own copy, when the Requests page opens, then its line says only whether it merges, with no forge words", async ({ page }) => {
  // given
  await page.route((url) => url.pathname === "/api/requests", (route) =>
    route.fulfill({ json: { requests: [{ ...request(41, "Local one"), url: "local://requests/payments-skills/41", provider: "local" }], total: 1, counts: { open: 1, merged: 0, closed: 0 }, pageSize: 50, next: null } }),
  );
  await page.route("**/api/repos/payments-skills/requests/41/status", (route) =>
    route.fulfill({ json: { status: { source: "local", capabilities: null, detail: { number: 41, status: "open", headSha: "d4", checks: { state: "no-ci", checks: [] }, review: { decision: "none", approvedBy: [] }, mergeability: { state: "conflict", reason: "the branch conflicts with its base" } }, comments: [], fingerprint: "f" } } }),
  );

  // when
  await page.goto("/demo/repositories/payments-skills/requests");

  // then
  const row = page.getByRole("row", { name: /Local one/ });
  await expect(row.locator(".forge-state")).toHaveText("has a conflict to resolve");
  await expect(row).not.toContainText("forge");
  await expect(row).not.toContainText("no CI");
});

test("given a request on this machine's own copy pushed to after its check with a push that breaks the team's rules, when the Requests page opens, then it says it changed after the check and why, and offers no Merge until a later push passes", async ({ page }) => {
  // given
  const local = (number: number, title: string, held?: { heldHead: string; heldReason: string }) => ({ ...request(number, title), url: `local://requests/payments-skills/${number}`, provider: "local", checkedHead: "a1", ...held });
  await page.route((url) => url.pathname === "/api/requests", (route) =>
    route.fulfill({ json: { requests: [local(41, "Checked one"), local(42, "Pushed after", { heldHead: "b2", heldReason: "b2 changes .claude/settings.json, which the team keeps to its owners" })], total: 2, counts: { open: 2, merged: 0, closed: 0 }, pageSize: 50, next: null } }),
  );
  await page.route("**/api/repos/payments-skills/requests/*/status", (route) =>
    route.fulfill({ json: { status: { source: "local", capabilities: null, detail: { number: 41, status: "open", headSha: "a1", checks: { state: "no-ci", checks: [] }, review: { decision: "none", approvedBy: [] }, mergeability: { state: "mergeable", reason: null } }, comments: [], fingerprint: "f" } } }),
  );

  // when
  await page.goto("/demo/repositories/payments-skills/requests");

  // then
  const held = page.getByRole("row", { name: /Pushed after/ });
  await expect(held).toContainText("changed after the check B2 changes .claude/settings.json, which the team keeps to its owners. It merges once a later push passes the team's rules.");
  await expect(held.getByRole("button", { name: "Merge" })).toHaveCount(0);
  await expect(held.getByRole("button", { name: "Close" })).toBeVisible();
  const checked = page.getByRole("row", { name: /Checked one/ });
  await expect(checked).toContainText("ready to merge");
  await expect(checked.getByRole("button", { name: "Merge" })).toBeVisible();
});
