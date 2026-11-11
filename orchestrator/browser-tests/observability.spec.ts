import { expect, test } from "@playwright/test";

test("given the orchestrator as the browser suite starts it, when liveness, readiness and metrics are asked without signing in, then it is alive and ready, says nothing more, and serves no metrics without a token", async ({ request }) => {
  // when
  const live = await request.get("/api/health");
  const ready = await request.get("/api/health/ready");
  const scraped = await request.get("/metrics");

  // then
  expect(live.ok()).toBe(true);
  expect(await live.json()).toEqual({ ok: true });
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toEqual({ ready: true });
  expect(live.headers()["x-request-id"]).toMatch(/^[0-9a-f]{16}$/);
  expect([404, 401]).toContain(scraped.status());
});
