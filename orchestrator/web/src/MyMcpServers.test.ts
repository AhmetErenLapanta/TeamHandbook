import { describe, expect, it } from "vitest";
import { firstPick, groupTools } from "./MyMcpServers";

const loaded = [
  { name: "getJiraIssue", writes: false, reads: true },
  { name: "createJiraIssue", writes: true, reads: false },
  { name: "searchJiraIssuesUsingJql", writes: false, reads: true },
  { name: "transitionJiraIssue", writes: true, reads: false },
  { name: "jira_digest", writes: false, reads: false },
];

describe("picking a server's tools", () => {
  it("given a server whose tools are loaded for the first time, when they are shown, then only the ones that surely read are ticked, and a writing one or one the server does not say reads waits for the person", () => {
    // given
    const saved: string[] = [];

    // when
    const ticked = firstPick(loaded, saved);

    // then
    expect(ticked).toEqual(["getJiraIssue", "searchJiraIssuesUsingJql"]);
  });

  it("given a person who saved a narrower pick, when the tools are loaded again, then their pick stays", () => {
    // given
    const saved = ["getJiraIssue"];

    // when
    const ticked = firstPick(loaded, saved);

    // then
    expect(ticked).toEqual(["getJiraIssue"]);
  });

  it("given reading and writing tools, when they are grouped, then Reads and Writes each hold their own", () => {
    // when
    const { reads, writes } = groupTools(loaded);

    // then
    expect(reads.map((t) => t.name)).toEqual(["getJiraIssue", "searchJiraIssuesUsingJql", "jira_digest"]);
    expect(writes.map((t) => t.name)).toEqual(["createJiraIssue", "transitionJiraIssue"]);
  });
});
