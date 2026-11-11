import { describe, expect, it } from "vitest";
import { FORGES, recognizeForge } from "../../shared/forge-def.js";
import { GITEA_ADMIN } from "./gitea-admin.js";
import { DRIVERS, driverTable } from "./registry.js";

describe("the forge drivers", () => {
  it("given a forge's driver listed twice, when the table is made, then the orchestrator stops", () => {
    expect(() => driverTable([DRIVERS.gitlab, DRIVERS.github, DRIVERS.gitlab])).toThrow(/two forge drivers for gitlab/);
  });

  it("given a hosted forge with no driver, when the table is made, then the orchestrator stops naming it", () => {
    expect(() => driverTable([DRIVERS.gitlab])).toThrow(/no forge driver for github/);
  });

  it("given a token, when each driver sends it, then GitLab takes the connection's as a bearer and a pasted one in PRIVATE-TOKEN, GitHub both as a bearer", () => {
    expect(DRIVERS.gitlab.authHeaders("t0ken-value", true)).toEqual({ authorization: "Bearer t0ken-value" });
    expect(DRIVERS.gitlab.authHeaders("t0ken-value", false)).toEqual({ "PRIVATE-TOKEN": "t0ken-value" });
    expect(DRIVERS.github.authHeaders("t0ken-value", false)).toMatchObject({ authorization: "Bearer t0ken-value" });
  });
});

describe("the team repository form each forge's definition describes", () => {
  it("given each forge, when its form is read from its definition, then GitLab offers internal and a group, GitHub neither, Gitea an organization, and the server takes the same visibilities the form offers", () => {
    expect(FORGES.gitlab).toMatchObject({ visibilities: ["private", "internal", "public"], group: { label: "Group (optional)", placeholder: "acme/platform" } });
    expect(FORGES.github).toMatchObject({ visibilities: ["private", "public"], group: null });
    expect(FORGES.gitea).toMatchObject({ visibilities: ["private", "public"], group: { label: "Organization (optional)" } });
    for (const kind of ["gitlab", "github"] as const) {
      expect(DRIVERS[kind].admin.visibilities).toEqual(FORGES[kind].visibilities);
      expect(FORGES[kind].visibilities[0]).toBe("private");
      expect(FORGES[kind].emptyListHint).toMatch(/then read the list again\.$/);
    }
  });
});

describe("the forge's own page that opens a request", () => {
  it("given a pushed branch with slashes, when each forge's page is made, then it names the branch and the target, each part encoded", () => {
    expect(FORGES.gitlab.newRequestUrl("https://gitlab.example.invalid/", "acme/skills", "handbook/add retry", "main")).toBe(
      "https://gitlab.example.invalid/acme/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=handbook%2Fadd+retry&merge_request%5Btarget_branch%5D=main",
    );
    expect(FORGES.github.newRequestUrl("https://github.com", "acme/skills", "handbook/add#retry", "main")).toBe("https://github.com/acme/skills/compare/main...handbook/add%23retry?expand=1");
    expect(FORGES.gitea.newRequestUrl("https://gitea.example.invalid/", "acme/skills", "handbook/add#retry", "main")).toBe("https://gitea.example.invalid/acme/skills/compare/main...handbook/add%23retry");
  });
});

describe("Gitea's definition, kept apart until it is offered", () => {
  it("given a self-hosted Gitea, when its API, a request's ref and the token page are worked out, then the API is /api/v1 beside the repository, the ref is refs/pull/<n>/head and the token page is the account's applications", () => {
    expect(FORGES.gitea.apiUrlFor(new URL("https://git.example.invalid/acme/skills.git"))).toBe("https://git.example.invalid/api/v1");
    expect(FORGES.gitea.requestRef(7)).toBe("refs/pull/7/head");
    expect(FORGES.gitea.credentials.tokenPage("https://git.example.invalid/")).toBe("https://git.example.invalid/user/settings/applications");
    expect(FORGES.gitea.allowsHost("git.example.invalid")).toBe(true);
    expect(GITEA_ADMIN.visibilities).toEqual(FORGES.gitea.visibilities);
  });
});

describe("recognising a repository's forge from its address", () => {
  it("given each forge's own service, when an address there is read, then it is that forge", () => {
    expect(recognizeForge("https://github.com/acme/skills.git")).toBe("github");
    expect(recognizeForge("https://gitlab.com/acme/skills.git")).toBe("gitlab");
  });

  it("given a self-managed GitLab the orchestrator reaches, when an address there is read, then it is GitLab", () => {
    expect(recognizeForge("https://git.example.com/acme/skills.git", { gitlab: ["git.example.com"] })).toBe("gitlab");
  });

  it("given a host no forge claims, or no address at all, when it is read, then the person names the forge", () => {
    expect(recognizeForge("https://git.example.com/acme/skills.git")).toBeNull();
    expect(recognizeForge("not an address")).toBeNull();
  });
});

describe("where each forge's API sits", () => {
  it("given a repository's origin, when the API root is worked out, then GitHub's is its API host or a stand-in's /api, GitLab's /api/v4 beside it", () => {
    expect(FORGES.github.apiUrlFor(new URL("https://github.com/acme/skills"))).toBe("https://api.github.com");
    expect(FORGES.github.apiUrlFor(new URL("http://127.0.0.1:9000/acme/skills"))).toBe("http://127.0.0.1:9000/api");
    expect(FORGES.gitlab.apiUrlFor(new URL("https://git.example.com:8443/acme/skills"))).toBe("https://git.example.com:8443/api/v4");
  });

  it("given a host, when a repository there is checked, then GitHub takes only github.com or this machine and GitLab any", () => {
    expect(FORGES.github.allowsHost("git.example.com")).toBe(false);
    expect(FORGES.github.allowsHost("127.0.0.1")).toBe(true);
    expect(FORGES.gitlab.allowsHost("git.example.com")).toBe(true);
  });
});
