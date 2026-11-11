import { describe, expect, it } from "vitest";
import { machineMcpServers } from "./machine-mcp.js";

describe("a project's MCP servers filled on the person's machine", () => {
  it("given servers whose values name variables the person has set, when the machine fills them, then each value comes from the person's environment, the filled values are handed to the masker, and the log names which variables each server takes", () => {
    // given
    const servers = {
      docs: { type: "http" as const, url: "https://docs.example.invalid/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Team": "payments" } },
      ledger: { type: "stdio" as const, command: "ledger-mcp", args: ["--read-only"], env: { LEDGER_URL: "${LEDGER_URL}" } },
    };

    // when
    const filled = machineMcpServers(servers, { DOCS_TOKEN: "stand-in-docs-value", LEDGER_URL: "https://ledger.example.invalid" });

    // then
    expect(filled.servers).toEqual({
      docs: { type: "http", url: "https://docs.example.invalid/mcp", headers: { Authorization: "Bearer stand-in-docs-value", "X-Team": "payments" } },
      ledger: { type: "stdio", command: "ledger-mcp", args: ["--read-only"], env: { LEDGER_URL: "https://ledger.example.invalid" } },
    });
    expect(filled.values).toEqual(["stand-in-docs-value", "https://ledger.example.invalid"]);
    expect(filled.notes).toEqual(["MCP server docs takes DOCS_TOKEN from your environment.", "MCP server ledger takes LEDGER_URL from your environment."]);
    expect(filled.notes.join(" ")).not.toContain("stand-in-docs-value");
  });

  it.each([
    ["a variable the person has not set", { Authorization: "Bearer ${DOCS_TOKEN}" }, {}, "MCP server docs left out: DOCS_TOKEN is not set on this machine."],
    ["a variable set to nothing", { Authorization: "Bearer ${DOCS_TOKEN}" }, { DOCS_TOKEN: "" }, "MCP server docs left out: DOCS_TOKEN is not set on this machine."],
    ["a reference that is no variable's name", { Authorization: "Bearer ${docs token}" }, { "docs token": "x" }, "MCP server docs left out: one of its values names no variable."],
  ])("given %s, when the machine fills the server, then it is left out, said by name only", (_case, headers, env, note) => {
    // when
    const filled = machineMcpServers({ docs: { type: "http", url: "https://docs.example.invalid/mcp", headers } }, env);

    // then
    expect(filled).toEqual({ servers: {}, values: [], notes: [note] });
  });
});
