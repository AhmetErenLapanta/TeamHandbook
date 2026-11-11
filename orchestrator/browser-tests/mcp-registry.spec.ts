import { expect, test } from "@playwright/test";

test("given an orchestrator started without ORCHESTRATOR_MCP_REGISTRY_URL, when the registry is read and a server approved, then nothing is read from any registry and nothing is approved", async ({ page }) => {
  // given
  await page.goto("/demo/activity");
  const request = page.request;
  const { csrf } = await (await request.get("/api/me")).json();

  // when
  const listed = await (await request.get("/api/mcp-registry")).json();
  const approving = await request.put("/api/mcp-registry/approved", { data: { name: "io.github.acme/tracker-mcp" }, headers: { "x-csrf-token": csrf } });

  // then
  expect(listed).toEqual({ configured: false, servers: [], approved: [] });
  expect(approving.status()).toBe(404);
  expect((await approving.json()).code).toBe("registry-off");
});
