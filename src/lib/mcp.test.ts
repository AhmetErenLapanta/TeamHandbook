import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditServer, formatServerList, mergeServersIntoMcpJson, readLocalServers, refusalMessage } from "./mcp.js";
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

  it("given a provider that puts the token in the endpoint, when audited, then the server is refused", () => {
    const zapier = { type: "http", url: "https://mcp.zapier.com/api/mcp/s/NjM4YTk5ZTQtYjk2Mi00/mcp" };
    const composio = { type: "http", url: "https://mcp.composio.dev/composio/server/3f9a2b1c-7d4e-4f8a-9b2c-1e5d6a7b8c9d/mcp" };
    const smithery = { type: "http", url: "https://server.smithery.ai/@org/srv/mcp?profile=abc123def456" };

    expect(auditServer(zapier)).toMatchObject({ migratable: false, reason: "url-token" });
    expect(auditServer(composio)).toMatchObject({ migratable: false, reason: "url-token" });
    expect(auditServer(smithery)).toMatchObject({ migratable: false, reason: "url-token" });
    // the shape both other nets were measured to miss: no keyword, no pattern, and the
    // endpoint would have been printed in the merge request under a promise of safety
    expect(detectSecret(JSON.stringify(zapier))).toBeNull();
    expect(detectSecret(JSON.stringify(smithery))).toBeNull();
  });

  it("given ordinary endpoints, when audited, then the token scan does not refuse them", () => {
    // the other half of a heuristic: a net tested only on what it must catch quietly
    // refuses everything, and a manager with nothing shareable never runs the command twice
    const legitimate = [
      "https://mcp.notion.com/mcp",
      "https://gitlab.com/api/v4/mcp",
      "https://mcp.atlassian.com/v1/mcp",
      "https://mcp.example.com/v2beta1/mcp",
      "https://mcp.example.com/streamable-http-v1/mcp",
      "https://mcp.example.com/mcp?transport=streamable-http",
      "https://api.githubcopilot.com/mcp/",
    ];

    for (const url of legitimate) {
      expect({ url, ...auditServer({ type: "http", url }) }).toMatchObject({ url, migratable: true });
    }
  });

  it("given a token in the endpoint, when it is reported, then the message says where it is", () => {
    const message = refusalMessage("zapier", auditServer({ type: "http", url: "https://mcp.zapier.com/api/mcp/s/NjM4YTk5ZTQtYjk2Mi00/mcp" }));

    expect(message).toContain("NjM4YTk5ZTQtYjk2Mi00");
    expect(message).toContain("every teammate");
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

describe("mergeServersIntoMcpJson", () => {
  const gitlab = { type: "http", url: "https://gitlab.com/api/v4/mcp" };
  const one = (config: Record<string, unknown> = gitlab) => [{ name: "gitlab", scope: "user" as const, config }];

  it("given no file in the team repository yet, when a server is added, then it is created in the documented shape", () => {
    const { merged } = mergeServersIntoMcpJson(null, one());

    expect(JSON.parse(merged)).toEqual({ mcpServers: { gitlab } });
    expect(merged.endsWith("\n")).toBe(true);
  });

  it("given a file that already wraps its servers, when a server is added, then the existing one is untouched", () => {
    const existing = JSON.stringify({ mcpServers: { linear: { type: "sse", url: "https://mcp.linear.app/sse" } } }, null, 2);

    const parsed = JSON.parse(mergeServersIntoMcpJson(existing, one()).merged);

    expect(parsed.mcpServers.linear).toEqual({ type: "sse", url: "https://mcp.linear.app/sse" });
    expect(parsed.mcpServers.gitlab).toEqual(gitlab);
  });

  it("given a file written as a bare server map, when a server is added, then its shape is preserved rather than normalised", () => {
    const existing = JSON.stringify({ terraform: { command: "terraform-mcp" } }, null, 2);

    const parsed = JSON.parse(mergeServersIntoMcpJson(existing, one()).merged);

    // wrapping this file would demote `terraform` from a declaration to a stray key and
    // the team's working server would quietly stop loading
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.terraform).toEqual({ command: "terraform-mcp" });
    expect(parsed.gitlab).toEqual(gitlab);
  });

  it("given the team already declares that name, when a server is added, then it collides instead of overwriting theirs", () => {
    const theirs = { type: "http", url: "https://gitlab.example.com/api/v4/mcp" };
    const existing = JSON.stringify({ mcpServers: { gitlab: theirs } });

    const { merged, collided, replaced } = mergeServersIntoMcpJson(existing, one());

    // the default answer to a matching name is a refusal, and the refusal has to leave
    // their definition byte-for-byte where it was: consent to replace is a second request
    expect(collided).toEqual(["gitlab"]);
    expect(replaced).toEqual([]);
    expect(JSON.parse(merged).mcpServers.gitlab).toEqual(theirs);
  });

  it("given the publisher consented to that one name, when it is merged, then theirs is replaced and the swap is reported", () => {
    const existing = JSON.stringify({ mcpServers: { gitlab: { type: "http", url: "https://gitlab.example.com/api/v4/mcp" } } });

    const { merged, collided, replaced } = mergeServersIntoMcpJson(existing, one(), (name) => name === "gitlab");

    expect(collided).toEqual([]);
    expect(replaced).toEqual(["gitlab"]);
    expect(JSON.parse(merged).mcpServers.gitlab).toEqual(gitlab);
  });

  it("given a team file that is not valid JSON, when a server is added, then nothing is overwritten", () => {
    // a property of the repository, not of any one server: no selection survives it, so it
    // throws rather than joining the per-server collisions
    expect(() => mergeServersIntoMcpJson('{"mcpServers": ', one())).toThrow(/not valid JSON/);
  });

  it("given a team file that is not a JSON object, when a server is added, then nothing is overwritten", () => {
    expect(() => mergeServersIntoMcpJson("[]", one())).toThrow(/not a JSON object/);
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
