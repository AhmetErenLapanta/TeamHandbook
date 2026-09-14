import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditServer, formatServerList, mergeServerIntoMcpJson, readLocalServers, refusalMessage } from "./mcp.js";
import { detectSecret } from "./secrets.js";

let dir: string;
let configFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handbook-mcp-"));
  configFile = join(dir, ".claude.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("auditServer", () => {
  it("given a remote server that carries no credentials, when audited, then it may travel to the team", () => {
    const audit = auditServer({ type: "http", url: "https://gitlab.com/api/v4/mcp" });

    expect(audit).toEqual({
      migratable: true,
      requiresEnv: [],
      startsProcess: false,
      transport: "http",
    });
  });

  it("given a literal in a header, when audited, then it is refused on structure alone - not on pattern", () => {
    const withBearer = { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer 8f2c41d9ab7e05631cd4a29f" } };
    const withCookie = { type: "http", url: "https://api.example.com/mcp", headers: { Cookie: "session=9f13ab2c6d" } };
    const withShortBearer = { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer 8f2c41d9ab7e0563" } };

    expect(auditServer(withBearer)).toMatchObject({ migratable: false, reason: "credential-field", detail: "headers.Authorization" });
    expect(auditServer(withCookie)).toMatchObject({ migratable: false, reason: "credential-field", detail: "headers.Cookie" });
    expect(auditServer(withShortBearer)).toMatchObject({ migratable: false, reason: "credential-field", detail: "headers.Authorization" });
    // These two are the lock. detectSecret sees nothing in either, so if anyone ever
    // turns the structural rule back into a pattern list, this test goes red instead of
    // a live credential going into a team repository.
    expect(detectSecret(JSON.stringify(withCookie))).toBeNull();
    expect(detectSecret(JSON.stringify(withShortBearer))).toBeNull();
  });

  it("given an environment value that only references a variable, when audited, then the name travels and the value does not", () => {
    const audit = auditServer({ command: "npx", args: ["@acme/mcp"], env: { API_KEY: "${MY_API_KEY}" } });

    expect(audit).toMatchObject({ migratable: true, requiresEnv: ["MY_API_KEY"], startsProcess: true });
  });

  it("given a reference with a literal fallback, when audited, then it is refused because the fallback is the secret", () => {
    const audit = auditServer({ command: "npx", args: ["@acme/mcp"], env: { API_KEY: "${MY_API_KEY:-8f2c41d9ab7e0563}" } });

    expect(audit).toMatchObject({ migratable: false, reason: "credential-field", detail: "env.API_KEY" });
  });

  it("given a stdio server, when audited, then it may travel but is marked as starting a process", () => {
    const audit = auditServer({ command: "npx", args: ["@playwright/mcp@latest"] });

    expect(audit).toMatchObject({ migratable: true, startsProcess: true, transport: "stdio" });
  });

  it("given a credential the structural rule cannot see, when audited, then the pattern net still refuses it", () => {
    const audit = auditServer({ type: "http", url: "https://admin:hunter2pass@mcp.example.com/mcp" });

    expect(audit).toMatchObject({ migratable: false, reason: "secret-pattern", detail: "url-credentials" });
  });

  it("given something that is neither a process nor an endpoint, when audited, then it is refused rather than guessed at", () => {
    expect(auditServer({ type: "http" })).toMatchObject({ migratable: false, reason: "unsupported-shape" });
    expect(auditServer("gitlab")).toMatchObject({ migratable: false, reason: "unsupported-shape" });
  });

  it("given a refusal, when it is reported, then the message names the key to rewrite", () => {
    const message = refusalMessage("acme", auditServer({ type: "http", url: "https://x/mcp", headers: { "X-Api-Key": "abc12345" } }));

    expect(message).toContain("headers.X-Api-Key");
    expect(message).toContain("${VAR}");
  });
});

describe("readLocalServers", () => {
  it("given servers in user and project scope, when read, then both are offered and the project one wins its name", () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        mcpServers: { GitLab: { type: "http", url: "https://gitlab.com/api/v4/mcp" }, notion: { type: "http", url: "https://mcp.notion.com/mcp" } },
        projects: {
          "/work/here": { mcpServers: { notion: { type: "http", url: "https://mcp.notion.com/project" } } },
          "/work/elsewhere": { mcpServers: { "other-team": { type: "http", url: "https://internal.example.com/mcp" } } },
        },
      }),
    );

    const servers = readLocalServers(configFile, "/work/here");

    expect(servers.map((s) => `${s.name}:${s.scope}`)).toEqual(["GitLab:user", "notion:project"]);
    // another project's server belongs to that project's team, not this one
    expect(servers.find((s) => s.name === "other-team")).toBeUndefined();
    expect(servers[1]!.config).toEqual({ type: "http", url: "https://mcp.notion.com/project" });
  });

  it("given a config file that cannot be parsed, when read, then nothing is offered and nothing is shared", () => {
    writeFileSync(configFile, '{"mcpServers": {"GitLab": ');

    expect(readLocalServers(configFile, "/work/here")).toEqual([]);
  });

  it("given no config file at all, when read, then the absence is not an error", () => {
    expect(readLocalServers(join(dir, "absent.json"), "/work/here")).toEqual([]);
  });
});

describe("mergeServerIntoMcpJson", () => {
  const gitlab = { type: "http", url: "https://gitlab.com/api/v4/mcp" };

  it("given no file in the team repository yet, when a server is added, then it is created in the documented shape", () => {
    const text = mergeServerIntoMcpJson(null, "gitlab", gitlab);

    expect(JSON.parse(text)).toEqual({ mcpServers: { gitlab } });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("given a file that already wraps its servers, when a server is added, then the existing one is untouched", () => {
    const existing = JSON.stringify({ mcpServers: { linear: { type: "sse", url: "https://mcp.linear.app/sse" } } }, null, 2);

    const parsed = JSON.parse(mergeServerIntoMcpJson(existing, "gitlab", gitlab));

    expect(parsed.mcpServers.linear).toEqual({ type: "sse", url: "https://mcp.linear.app/sse" });
    expect(parsed.mcpServers.gitlab).toEqual(gitlab);
  });

  it("given a file written as a bare server map, when a server is added, then its shape is preserved rather than normalised", () => {
    const existing = JSON.stringify({ terraform: { command: "terraform-mcp" } }, null, 2);

    const parsed = JSON.parse(mergeServerIntoMcpJson(existing, "gitlab", gitlab));

    // wrapping this file would demote `terraform` from a declaration to a stray key and
    // the team's working server would quietly stop loading
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.terraform).toEqual({ command: "terraform-mcp" });
    expect(parsed.gitlab).toEqual(gitlab);
  });

  it("given the team already declares that name, when a server is added, then it refuses instead of overwriting theirs", () => {
    const existing = JSON.stringify({ mcpServers: { gitlab: { type: "http", url: "https://gitlab.example.com/api/v4/mcp" } } });

    expect(() => mergeServerIntoMcpJson(existing, "gitlab", gitlab)).toThrow(/already declares/);
  });

  it("given a team file that is not valid JSON, when a server is added, then nothing is overwritten", () => {
    expect(() => mergeServerIntoMcpJson('{"mcpServers": ', "gitlab", gitlab)).toThrow(/not valid JSON/);
  });
});

describe("formatServerList", () => {
  it("given a server it cannot share, when the list is printed, then the reason is printed with it", () => {
    const text = formatServerList([
      { name: "gitlab", scope: "user", config: { type: "http", url: "https://gitlab.com/api/v4/mcp" } },
      { name: "acme-api", scope: "project", config: { type: "http", url: "https://api.acme.com/mcp", headers: { Authorization: "Bearer 8f2c41d9ab7e05631cd4a29f" } } },
      { name: "playwright", scope: "project", config: { command: "npx", args: ["@playwright/mcp@latest"] } },
    ]);

    expect(text).toContain("gitlab  [user, http]  shareable");
    // a manager who is not told why assumes the server simply does not exist
    expect(text).toContain("acme-api  [project, http]  not shareable: headers.Authorization holds a literal value");
    expect(text).toContain("starts a process on every teammate's machine");
  });

  it("given nothing configured, when the list is printed, then it says so instead of printing an empty table", () => {
    expect(formatServerList([])).toContain("No MCP servers are configured");
  });
});
