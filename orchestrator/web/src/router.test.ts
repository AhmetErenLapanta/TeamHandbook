import { describe, expect, it } from "vitest";
import { legacyPath, movedPath, pathIn, placeOf, rootTarget } from "./router";

describe("placeOf", () => {
  it("given a path inside an organization, when read, then the organization, section and rest come apart", () => {
    // given
    const path = "/acme/repositories/payments-skills";

    // when
    const place = placeOf(path);

    // then
    expect(place).toEqual({ org: "acme", section: "repositories", named: true, rest: ["payments-skills"] });
  });

  it("given a section the orchestrator does not have, when read, then no section is named", () => {
    // given
    const path = "/acme/billing";

    // when
    const place = placeOf(path);

    // then
    expect(place.section).toBeNull();
    expect(place.named).toBe(true);
  });
});

describe("pathIn", () => {
  it("given parts with characters a path reserves, when joined, then each part is encoded on its own", () => {
    // given
    const parts = ["settings", "a/b"];

    // when
    const path = pathIn("acme corp", ...parts);

    // then
    expect(path).toBe("/acme%20corp/settings/a%2Fb");
  });
});

describe("legacyPath", () => {
  it("given each address from before the top sections, when mapped, then it lands on the same page in the organization", () => {
    // given
    const old = ["#/repo/payments-skills", "#/tasks/0123456789ab", "#/tasks", "#/requests", "#/people", "#/settings/members/u1", "#/integrations", "#/login?problem=x", "#/", "#/billing"];

    // when
    const mapped = old.map((hash) => legacyPath(hash, "acme"));

    // then
    expect(mapped).toEqual([
      "/acme/repositories/payments-skills",
      "/acme/tasks/0123456789ab",
      "/acme/tasks",
      "/acme/tasks",
      "/acme/settings/members",
      "/acme/settings/members/u1",
      "/acme/integrations",
      "/acme/tasks",
      "/acme/tasks",
      "/acme/billing",
    ]);
  });

  it("given an in-page anchor or an invitation link rather than an old route, when mapped, then it is left alone", () => {
    // given
    const hash = "#content";

    // when
    const mapped = [legacyPath(hash, "acme"), legacyPath("#/join/abc-123", "acme")];

    // then
    expect(mapped).toEqual([null, null]);
  });
});

describe("rootTarget", () => {
  it("given the installed app's shortcuts, a shared link, shared text and nothing, when an address with no organization opens, then each lands on its page in the person's own", () => {
    // when
    const landed = ["?go=tasks", "?go=my-work", "?title=Bug&text=see+this&url=https%3A%2F%2Ftracker.example%2Fbrowse%2FPAY-1", "?text=Tidy+the+refund+skill", ""].map((q) => rootTarget(q, "acme"));

    // then
    expect(landed).toEqual([
      "/acme/tasks",
      "/acme/work?mine=1",
      "/acme/work/new?issue=https%3A%2F%2Ftracker.example%2Fbrowse%2FPAY-1",
      "/acme/work/new?issue=Tidy+the+refund+skill",
      "/acme/tasks",
    ]);
  });
});

describe("movedPath", () => {
  it("given each page that left the top bar, when it is opened, then it lands where it lives now, and a page that stayed is left alone", () => {
    // when
    const moved = [
      movedPath("acme", "activity", []),
      movedPath("acme", "repositories", []),
      movedPath("acme", "repositories", ["requests"]),
      movedPath("acme", "controls", []),
      movedPath("acme", "controls", ["new"]),
      movedPath("acme", "controls", ["pol_1"]),
      movedPath("acme", "activity", ["usage"]),
      movedPath("acme", "repositories", ["payments-skills", "skills"]),
      movedPath("acme", "tasks", []),
    ];

    // then
    expect(moved).toEqual(["/acme/tasks", "/acme/tasks", "/acme/tasks", "/acme/team", "/acme/team/policies/new", "/acme/team/policies/pol_1", null, null, null]);
  });
});
