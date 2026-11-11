import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityEventDays, identityFunnel } from "./identity-funnel.js";
import type { IdentityEvent } from "./identity-funnel.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "th-funnel-"));
  store = openSqliteStore(join(dir, "orchestrator.db"));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const step = (identityId: string, at: string, kind: IdentityEvent["kind"], org: string | null = null, provider: IdentityEvent["provider"] = "google"): IdentityEvent => ({ id: `ide_${++n}`, identityId, at, kind, provider, emailDomain: "example.invalid", org });
const orgEvent = (tenant: string, id: string, at: string, kind: string) => ({ tenant, id, at, kind, actor: { kind: "user" as const, id: "usr_a", email: "a@example.invalid", name: "A" }, repoId: null, subject: null, detail: kind });

describe("how far the people who signed up got", () => {
  it("given one who only signed up, one whose new organization connected a forge and started a task, and one who joined by invitation, when the funnel is read, then each has their furthest step and the counts narrow step by step", async () => {
    // given
    await store.recordIdentityEvent(step("idn_a", "2026-11-02T09:00:00.000Z", "signup.started", null, "github"));
    await store.recordIdentityEvent(step("idn_b", "2026-11-02T10:00:00.000Z", "signup.completed"));
    await store.recordIdentityEvent(step("idn_b", "2026-11-02T10:05:00.000Z", "org.created", "acme"));
    await store.recordIdentityEvent(step("idn_c", "2026-11-02T11:00:00.000Z", "signup.completed"));
    await store.recordIdentityEvent(step("idn_c", "2026-11-02T11:01:00.000Z", "invite.accepted", "acme"));
    await store.appendEvent(orgEvent("acme", "evt_1", "2026-11-02T10:10:00.000Z", "forge.connected"));
    await store.appendEvent(orgEvent("acme", "evt_2", "2026-11-02T10:20:00.000Z", "task.started"));

    // when
    const funnel = await identityFunnel(store, "2026-11-01T00:00:00.000Z");

    // then
    expect(funnel.people.map((p) => [p.identityId, p.provider, p.lastStep, p.orgCreated?.tenant ?? null, p.viaInvite])).toEqual([
      ["idn_a", "github", "signed up", null, false],
      ["idn_b", "google", "started a first task", "acme", false],
      ["idn_c", "google", "signed up", null, true],
    ]);
    expect(funnel.counts).toEqual({ "signed up": 3, "created an organization": 1, "connected a forge": 1, "started a first task": 1, "merged a first request": 0 });
    expect(JSON.stringify(funnel)).not.toContain("@");
  });

  it("given the retention setting unset, set and set wrong, when it is read, then it is 90 days, the days given, or refused", () => {
    expect(identityEventDays({})).toBe(90);
    expect(identityEventDays({ ORCHESTRATOR_IDENTITY_EVENTS_DAYS: "30" })).toBe(30);
    expect(() => identityEventDays({ ORCHESTRATOR_IDENTITY_EVENTS_DAYS: "0" })).toThrow(/whole number of days/);
  });
});
