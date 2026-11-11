import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { callTool, copyFile, pluginMcpTool, updateMarketplace } from "../machine.js";
import { ownerKey, userOf } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, close, commitOnDefault, fileAt, lab, merge, pluginName, SHAPES, teammateOn, unique } from "./support.js";

const SERVER = "teamhandbook-orchestrator";
/** Where a teammate's Claude Code waits for the approval to come back; nothing listens, the code is read from the redirect. */
const REDIRECT = "http://127.0.0.1:9/callback";

type Entry = { type: string; url: string; headers?: Record<string, string> };

/** The orchestrator's server as the team file declares it, from the teammate's own copy. */
function entryIn(copy: string | null): Entry | null {
  return copy ? ((JSON.parse(copy) as { mcpServers?: Record<string, Entry> }).mcpServers?.[SERVER] ?? null) : null;
}

/** A person's own API key, made signed in as them. */
async function ownKey(org: LabOrg, key: string): Promise<string> {
  const person = await OrchestratorClient.signIn(org.url, userOf(org, key).email, lab.password);
  return (await person.ok<{ secret: string }>("POST", "/api/keys", { name: unique("mcp"), scopes: { repositories: "read", requests: "write", tasks: "read" }, expiresInDays: 1 })).secret;
}

/** An MCP client's sign-in state, kept in memory as Claude Code keeps it on disk; the approval page it would open is recorded. */
function signInState() {
  const kept: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; opened?: URL } = {};
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT;
    },
    get clientMetadata() {
      return { client_name: "Claude Code", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    },
    clientInformation: () => kept.client,
    saveClientInformation: (info) => void (kept.client = info),
    tokens: () => kept.tokens,
    saveTokens: (tokens) => void (kept.tokens = tokens),
    redirectToAuthorization: (url) => void (kept.opened = url),
    saveCodeVerifier: (v) => void (kept.verifier = v),
    codeVerifier: () => kept.verifier!,
  };
  return { provider, kept };
}

/**
 * Claude Code reaching the address the team file declares, as `key` would: the first connect
 * is refused and opens the orchestrator's approval page, the person approves it in a browser signed
 * in to the orchestrator with the write scopes ticked, and the client connects with its tokens.
 */
async function connect(org: LabOrg, entry: Entry, key: string): Promise<{ client: Client; tokens: OAuthTokens }> {
  const { cookie } = await OrchestratorClient.signIn(org.url, userOf(org, key).email, lab.password);
  const { provider, kept } = signInState();
  const url = new URL(entry.url);
  await expect(new Client({ name: "lab-teammate", version: "1.0.0" }).connect(new StreamableHTTPClientTransport(url, { authProvider: provider }))).rejects.toThrow();
  const html = await (await fetch(kept.opened!, { headers: { cookie } })).text();
  const form = new URLSearchParams({ consent: /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? "", org: /name="org" value="([^"]+)"/.exec(html)?.[1] ?? "", decision: "approve" });
  for (const scope of [...[...html.matchAll(/type="hidden" name="scope" value="([^"]+)"/g)].map((m) => m[1]!), "requests:write"]) form.append("scope", scope);
  const back = await fetch(new URL("/oauth/authorize", kept.opened!), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
  await new StreamableHTTPClientTransport(url, { authProvider: provider }).finishAuth(new URL(back.headers.get("location")!).searchParams.get("code")!);
  const client = new Client({ name: "lab-teammate", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  return { client, tokens: kept.tokens! };
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");
const skillText = (slug: string) => `---\nname: ${slug}\ndescription: Use when the lab checks the orchestrator's MCP server.\n---\n\nBody.\n`;

/** The team's request that turns the orchestrator's server on, merged, unless an earlier run already did. */
async function turnOn(org: LabOrg, repo: LabRepo): Promise<void> {
  if (entryIn(fileAt(repo, "HEAD", ".mcp.json"))) return;
  const owner = await as(org, "admin");
  const proposal = await owner.ok<{ baseSha: string; proposal: string; branch: string }>("POST", `/api/integrations/orchestrator-mcp/${repo.id}/proposal`);
  const branch = proposal.branch.replace("<TICKET>", "LAB-501");
  const { request } = await owner.ok<{ request: { number: number } }>("POST", `/api/integrations/orchestrator-mcp/${repo.id}/propose`, { baseSha: proposal.baseSha, message: proposal.proposal, branch });
  await merge(org, repo, request.number);
}

test.describe("the orchestrator's own MCP server, from a teammate's Claude Code", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its request for the orchestrator's server is merged, then a teammate's copy declares its address alone, the team's owner signs in through the orchestrator and proposes through it and nothing merges, a member is offered no tool that writes, a call outside the owner's team is refused, every call made is logged, and a team policy blocks the tool on the teammate's machine`, async () => {
      // given
      await turnOn(org, repo);
      const m = teammateOn(org, repo);
      updateMarketplace(m);
      const entry = entryIn(copyFile(m, ".mcp.json"));

      // then the copy carries the server's address alone
      expect(entry).toEqual({ type: "http", url: `${org.url}/mcp` });

      // when the team's owner signs in through the orchestrator and proposes a change through it
      const { client: owner, tokens } = await connect(org, entry!, ownerKey(repo.team));
      const { tools } = await owner.listTools();
      const slug = unique("through-mcp");
      const change = { kind: "skill.add", slug, content: skillText(slug) };
      const preview = JSON.parse(text(await owner.callTool({ name: "preview_change", arguments: { repo: repo.id, change } }))) as { baseSha: string; proposal: string; branch: string };
      const proposed = JSON.parse(text(await owner.callTool({ name: "propose_change", arguments: { repo: repo.id, baseSha: preview.baseSha, change, message: preview.proposal, branch: preview.branch.replace("<TICKET>", "LAB-502") } }))) as { request: { number: number; status: string } };
      const elsewhere = org.repos.find((r) => r.team !== repo.team)!;
      const outside = await owner.callTool({ name: "preview_change", arguments: { repo: elsewhere.id, change } });
      await owner.close();

      try {
        // then the request is open and waits for a person
        expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_repositories", "preview_change", "propose_change"]));
        expect(proposed.request.status).toBe("open");
        const { requests } = await (await as(org, "admin")).ok<{ requests: { number: number; status: string }[] }>("GET", `/api/requests?repo=${repo.id}`);
        expect(requests.find((r) => r.number === proposed.request.number)?.status).toBe("open");

        // and the call on another team's repository is refused and logged
        expect((outside as { isError?: boolean }).isError).toBe(true);
        const log = await (await as(org, "org-admin")).ok<{ events: { subject: string; repoId: string | null; actor: { email: string } }[] }>("GET", "/api/events?kind=mcp");
        const byOwner = log.events.filter((e) => e.actor.email === userOf(org, ownerKey(repo.team)).email);
        expect(byOwner.some((e) => e.subject === "tool:propose_change" && e.repoId === repo.id)).toBe(true);
        expect(byOwner.some((e) => e.subject === "tool:preview_change" && e.repoId === elsewhere.id)).toBe(true);

        // when a member connects
        const { client: member } = await connect(org, entry!, "member");
        const offered = (await member.listTools()).tools.map((t) => t.name);
        const refused = await member.callTool({ name: "preview_change", arguments: { repo: repo.id, change } }).then(() => "made", (err: Error) => err.message);
        await member.close();

        // then nothing that writes is offered, and calling it anyway is refused before it is made
        expect(offered).toContain("list_repositories");
        expect(offered).not.toEqual(expect.arrayContaining(["preview_change"]));
        expect(offered).not.toEqual(expect.arrayContaining(["propose_change"]));
        expect(refused).toContain("is offered to you");

        // and no token the sign-in gave reaches the event log, an API key still reaches the server, and another organization's orchestrator refuses the token
        const everything = JSON.stringify(await (await as(org, "org-admin")).ok("GET", "/api/events"));
        expect(everything).not.toContain(tokens.access_token);
        expect(everything).not.toContain(tokens.refresh_token!);
        const byKey = new Client({ name: "lab-automation", version: "1.0.0" });
        await byKey.connect(new StreamableHTTPClientTransport(new URL(entry!.url), { requestInit: { headers: { Authorization: `Bearer ${await ownKey(org, ownerKey(repo.team))}` } } }));
        expect((await byKey.listTools()).tools.map((t) => t.name)).toContain("propose_change");
        await byKey.close();
        const other = lab.orgs.find((o) => o !== org && !o.extra)!;
        const foreign = await fetch(`${other.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
        expect(foreign.status).toBe(401);

        // when the team's policy takes propose_change away
        const plugin = pluginName(repo);
        const team = JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json")!) as Record<string, unknown>;
        commitOnDefault(repo, { ".teamhandbook.json": JSON.stringify({ ...team, policies: [{ id: "lab-mcp", name: "Lab", rules: [{ action: "mcp.use", resource: `mcp:${SERVER}/propose_change`, effect: "deny", reason: "Requests go through the orchestrator page" }] }] }, null, 2) + "\n" }, "chore: hold back proposing from sessions");
        updateMarketplace(m);
        try {
          // then the teammate's session is stopped before the call, and reading still runs
          expect(callTool(m, unique("session"), pluginMcpTool(plugin, SERVER, "propose_change"), {}).denied).toContain("Requests go through the orchestrator page");
          expect(callTool(m, unique("session"), pluginMcpTool(plugin, SERVER, "list_requests"), {}).denied).toBeNull();
        } finally {
          commitOnDefault(repo, { ".teamhandbook.json": JSON.stringify(team, null, 2) + "\n" }, "chore: lift the hold");
          updateMarketplace(m);
        }
      } finally {
        await close(org, repo, proposed.request.number);
      }
    });
  }
});
