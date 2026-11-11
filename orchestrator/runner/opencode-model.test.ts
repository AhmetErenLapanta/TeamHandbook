import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepOpencodeModel, personalOpencodeModel } from "./opencode-model.js";

describe("the model a task's OpenCode run keeps from its person's own config", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "opencode-model-"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("given a person's config with their models, servers, plugins and rules, when a task keeps their setup out, then only the two model choices reach the task's config", async () => {
    // given
    writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), `{
  // the person's own choice
  "model": "stand-in-provider/stand-in-large",
  "small_model": "stand-in-provider/stand-in-small",
  "mcp": { "notebook": { "type": "local", "command": ["notebook-mcp"] } },
  "plugin": ["stand-in-plugin"],
  "permission": { "bash": "allow" },
}
`);
    const task = join(home, "task-opencode.json");
    writeFileSync(task, JSON.stringify({ permission: { "*": "deny" }, mcp: {} }));

    // when
    const model = await personalOpencodeModel({ HOME: home });
    await keepOpencodeModel(task, model);

    // then
    expect(model).toEqual({ model: "stand-in-provider/stand-in-large", small_model: "stand-in-provider/stand-in-small" });
    expect(JSON.parse(readFileSync(task, "utf8"))).toEqual({ permission: { "*": "deny" }, mcp: {}, model: "stand-in-provider/stand-in-large", small_model: "stand-in-provider/stand-in-small" });
  });

  it.each([
    ["a model that is an object", `{ "model": { "id": "x" } }`],
    ["a model that is no provider/model", `{ "model": "--config=/elsewhere" }`],
    ["a config that does not read", `{ "model": `],
  ])("given %s, when the task reads the person's config, then it keeps no model and its config is left as it is", async (_case, text) => {
    // given
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), text);
    const task = join(home, "task-opencode.json");
    writeFileSync(task, JSON.stringify({ permission: { "*": "deny" } }));

    // when
    const model = await personalOpencodeModel({ HOME: home });
    await keepOpencodeModel(task, model);

    // then
    expect(model).toEqual({});
    expect(JSON.parse(readFileSync(task, "utf8"))).toEqual({ permission: { "*": "deny" } });
  });
});
