import { describe, expect, it } from "vitest";
import { parseIssueLink } from "./issue.js";

describe("reading an issue link", () => {
  it("given a Jira, GitHub or GitLab issue address, when it is read, then its key is taken from the address", () => {
    expect(parseIssueLink("https://tracker.example.com/browse/PAY-142")).toEqual({ url: "https://tracker.example.com/browse/PAY-142", kind: "jira", key: "PAY-142", branchToken: "PAY-142" });
    expect(parseIssueLink("https://github.com/acme/payments-skills/issues/12")).toMatchObject({ kind: "github", key: "acme/payments-skills#12", branchToken: "payments-skills-12" });
    expect(parseIssueLink("https://git.example.com/acme/team/payments/-/issues/7")).toMatchObject({ kind: "gitlab", key: "acme/team/payments#7", branchToken: "payments-7" });
  });

  it("given an https address of a tracker the orchestrator does not recognise, when it is read, then it is kept with no key", () => {
    expect(parseIssueLink("https://linear.example.com/acme/issue/ENG-1/title")).toEqual({ url: "https://linear.example.com/acme/issue/ENG-1/title", kind: "other", key: null, branchToken: null });
  });

  it("given an address that is not https, carries a user, a secret or too much, when it is read, then it is refused", () => {
    for (const bad of [
      "http://tracker.example.com/browse/PAY-142",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not a link",
      "https://ada:hunter2@tracker.example.com/browse/PAY-142",
      `https://tracker.example.com/browse/PAY-142?token=${["ghp", "_", "a".repeat(36)].join("")}`,
      `https://tracker.example.com/${"x".repeat(600)}`,
      // Short as typed, long once URL encoding has turned each backtick into %60.
      `https://tracker.example.com/${"`".repeat(470)}`,
    ]) {
      expect(parseIssueLink(bad), bad).toHaveProperty("error");
    }
  });
});

describe("the tracker an issue link names", () => {
  it("given GitLab's issue path on github.com, when it is read, then it is not taken for a GitLab issue", () => {
    expect(parseIssueLink("https://github.com/acme/payments/-/issues/1")).toMatchObject({ kind: "other", key: null });
  });
});

describe("an issue link on the connected tracker", () => {
  it("given a tracker connected on this machine over http, when a link to it is read, then it is taken, while http elsewhere is refused naming the address expected", () => {
    // given
    const tracker = { url: "http://127.0.0.1:8085" };

    // when
    const own = parseIssueLink("http://127.0.0.1:8085/browse/PAY-142", tracker);
    const elsewhere = parseIssueLink("http://tracker.example.com/browse/PAY-142", tracker);
    const otherPort = parseIssueLink("http://127.0.0.1:9000/browse/PAY-142", tracker);

    // then
    expect(own).toEqual({ url: "http://127.0.0.1:8085/browse/PAY-142", kind: "jira", key: "PAY-142", branchToken: "PAY-142" });
    for (const refused of [elsewhere, otherPort]) expect(refused).toEqual({ error: "an issue link starts with https://, or with http://127.0.0.1:8085/, the connected tracker's address" });
  });

  it("given a tracker connected over https, when an http link to its own site is read, then it is refused, and a user and password are refused on the tracker's own site too", () => {
    // given
    const tracker = { url: "https://acme.atlassian.net" };

    // when
    const plain = parseIssueLink("http://acme.atlassian.net/browse/PAY-142", tracker);
    const withUser = parseIssueLink("http://ada:hunter2@127.0.0.1:8085/browse/PAY-142", { url: "http://127.0.0.1:8085" });

    // then
    expect(plain).toEqual({ error: "an issue link starts with https://" });
    expect(withUser).toEqual({ error: "an issue link carries no user name or password" });
  });
});

