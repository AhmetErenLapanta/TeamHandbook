import { describe, expect, it } from "vitest";
import type { MemberConfig } from "../../../shared/member-config";
import { draftEffects } from "./draft-effects";

const held = { resource: "skill:old", reason: "Already held." };

function config(change: Partial<MemberConfig["repos"][number]> = {}, refusal: string | null = null): MemberConfig {
  return {
    member: { id: "u", name: "Pat", email: "pat@example.invalid" },
    teams: ["Payments"],
    tags: [],
    repos: [{ repoId: "payments-skills", name: "payments-skills", team: "Payments", skills: [{ slug: "old", removedBy: held }, { slug: "deploy", removedBy: null }], mcpServers: [{ name: "postgres", removedBy: null, tools: [] }], commands: [], tools: [], problem: null, ...change }],
    tasks: [{ repoId: "payments-skills", name: "payments-skills", refusal }],
  };
}

describe("what a draft changes for one member", () => {
  it("given a draft that blocks a skill, a server tool and a Bash pattern, when compared, then each new removal is named once and what was held already is not", () => {
    // given
    const before = config();
    const after = config({
      skills: [{ slug: "old", removedBy: held }, { slug: "deploy", removedBy: { resource: "skill:deploy", reason: "Deploys go through CI." } }],
      mcpServers: [{ name: "postgres", removedBy: null, tools: [{ tool: "query", resource: "mcp:postgres/query", reason: "Read the warehouse." }] }],
      tools: [{ resource: "tool:Bash:rm *", reason: "Nothing is deleted." }],
    });

    // when
    const effects = draftEffects(before, after);

    // then
    expect(effects).toEqual([
      { what: "The skill deploy in payments-skills", reason: "Deploys go through CI." },
      { what: "The tool query on postgres in payments-skills", reason: "Read the warehouse." },
      { what: "Bash:rm * in payments-skills", reason: "Nothing is deleted." },
    ]);
  });

  it("given a draft that keeps the member off a repository, when compared, then the refused start is the one effect", () => {
    expect(draftEffects(config(), config({}, '"Hold" does not let you start tasks on payments-skills.'))).toEqual([
      { what: "Starting a task on payments-skills", reason: '"Hold" does not let you start tasks on payments-skills.' },
    ]);
  });

  it("given the same configuration before and after, when compared, then the draft changes nothing", () => {
    expect(draftEffects(config(), config())).toEqual([]);
  });
});
