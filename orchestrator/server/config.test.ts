import { describe, expect, it } from "vitest";
import { ConfigRefused, parseConfig, servedOrgs } from "./config.js";

const repo = { id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///srv/repos/payments.git" };

describe("the orchestrator's configuration file", () => {
  it("given a well-formed file, when it is read, then its tenant and repositories come back as written", () => {
    // given
    const raw = JSON.stringify({ tenant: "acme", repos: [{ ...repo, testCommand: "npm test", memberUrl: "https://git.example.invalid/acme/payments.git" }] });

    // when
    const config = parseConfig(raw, "orchestrator.json");

    // then
    expect(config).toEqual({ tenant: "acme", repos: [{ ...repo, testCommand: "npm test", memberUrl: "https://git.example.invalid/acme/payments.git" }] });
  });

  it.each([
    ["broken JSON", "{ tenant: ", /not valid JSON/],
    ["a list at the top", "[]", /must hold a JSON object/],
    ["a misspelled repos key", JSON.stringify({ repo: [repo] }), /"repo", which the orchestrator does not read/],
    ["repos that is not a list", JSON.stringify({ repos: {} }), /repos must be a list/],
    ["a repository without a url", JSON.stringify({ repos: [{ ...repo, url: undefined }] }), /repos\[0\]\.url must be a non-empty string/],
    ["an id with capitals", JSON.stringify({ repos: [{ ...repo, id: "Payments" }] }), /lowercase letters/],
    ["the same id twice", JSON.stringify({ repos: [repo, repo] }), /appears twice/],
    ["a misspelled repository key", JSON.stringify({ repos: [{ ...repo, testCmd: "npm test" }] }), /"testCmd", which the orchestrator does not read/],
    ["a tenant with a slash", JSON.stringify({ tenant: "acme/x" }), /tenant "acme\/x"/],
    ["orgs beside a top-level tenant", JSON.stringify({ tenant: "acme", orgs: [{ tenant: "beta" }] }), /"tenant" goes inside an entry of orgs/],
    ["an empty orgs list", JSON.stringify({ orgs: [] }), /at least one organization/],
    ["an org without a tenant", JSON.stringify({ orgs: [{ repos: [repo] }] }), /orgs\[0\]\.tenant must be a non-empty string/],
    ["sso that is not a boolean", JSON.stringify({ orgs: [{ tenant: "acme", sso: "yes" }] }), /orgs\[0\]\.sso must be true or false/],
    ["an org named after an orchestrator path", JSON.stringify({ orgs: [{ tenant: "api" }] }), /orgs\[0\]\.tenant "api" is a path the orchestrator answers itself/],
    ["the same org twice", JSON.stringify({ orgs: [{ tenant: "acme" }, { tenant: "acme" }] }), /orgs\[1\]\.tenant "acme" appears twice/],
    ["a repository twice in one org", JSON.stringify({ orgs: [{ tenant: "acme", repos: [repo, repo] }] }), /orgs\[0\]\.repos\[1\]\.id "payments-skills" appears twice/],
  ])("given %s, when it is read, then it is refused and names what is wrong", (_label, raw, message) => {
    // when
    const read = () => parseConfig(raw, "orchestrator.json");

    // then
    expect(read).toThrow(ConfigRefused);
    expect(read).toThrow(message);
  });

  it("given a file of several orgs, each with a repository of the same id, when it is read, then each org is served with its own", () => {
    // given
    const raw = JSON.stringify({ orgs: [{ tenant: "acme", repos: [repo], sso: true }, { tenant: "beta", repos: [{ ...repo, url: "file:///srv/repos/beta.git" }] }] });

    // when
    const orgs = servedOrgs(parseConfig(raw, "orchestrator.json"));

    // then
    expect(orgs).toEqual([
      { tenant: "acme", repos: [repo], sso: true },
      { tenant: "beta", repos: [{ ...repo, url: "file:///srv/repos/beta.git" }] },
    ]);
  });

  it.each([
    ["one tenant", { tenant: "acme", repos: [repo] }, [{ tenant: "acme", repos: [repo], sso: true }]],
    ["no tenant", { repos: [repo] }, [{ tenant: "default", repos: [repo], sso: true }]],
    ["no file", {}, [{ tenant: "default", sso: true }]],
  ])("given an install from before orgs with %s, when its orgs are read, then it opens as one org", (_label, config, orgs) => {
    expect(servedOrgs(config)).toEqual(orgs);
  });
});
