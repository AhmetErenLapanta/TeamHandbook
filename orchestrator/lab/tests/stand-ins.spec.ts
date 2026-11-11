import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { expect, test } from "@playwright/test";
import { TEST_REDIRECT } from "../cloud.js";
import { lab } from "./support.js";

// The lab's own stand-ins behave as the services they stand for, so a red elsewhere is the
// orchestrator's and not theirs.
test.describe("the lab's stand-in tracker services", () => {
  test("given the stand-in Jira, when an issue is read with the API token, then v3 gives its description as a document and v2 as text, a wrong token is refused and a write is refused", async () => {
    // given
    const jira = lab.jira!;
    const auth = { authorization: `Basic ${Buffer.from(`${jira.email}:${jira.token}`).toString("base64")}` };

    // when
    const v3 = (await (await fetch(`${jira.url}/rest/api/3/issue/PAY-142`, { headers: auth })).json()) as { fields: { summary: string; description: { type: string }; subtasks: unknown[]; comment: { total: number } } };
    const v2 = (await (await fetch(`${jira.url}/rest/api/2/issue/PAY-142`, { headers: auth })).json()) as { fields: { description: string } };
    const stranger = await fetch(`${jira.url}/rest/api/3/issue/PAY-142`, { headers: { authorization: "Basic bm8tb25lOm5vdGhpbmc=" } });
    const write = await fetch(`${jira.url}/rest/api/3/issue/PAY-142/comment`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });

    // then
    expect([v3.fields.summary, v3.fields.description.type, v3.fields.subtasks.length, v3.fields.comment.total]).toEqual(["Add a refund window check to the release checklist", "doc", 1, 2]);
    expect(v2.fields.description).toContain("Acceptance criteria");
    expect([stranger.status, write.status]).toEqual([401, 405]);
  });

  test("given the stand-in Jira's Agile API, when the Customers board is read, then its columns are the team's own workflow, its active sprint's three issues carry their sprint and points, its backlog and the sprint's JQL agree, a clause it cannot read is refused, a teammate's move shows in the next read, and an issue moves through its workflow only with the write token", async () => {
    // given
    const jira = lab.jira!;
    const get = async <T>(path: string) => {
      const res = await fetch(`${jira.url}${path}`, { headers: { authorization: `Basic ${Buffer.from(`${jira.email}:${jira.token}`).toString("base64")}` } });
      return { status: res.status, body: (await res.json()) as T };
    };
    type Issues = { total: number; issues: { key: string; fields: { status: { name: string; statusCategory: { key: string } }; customfield_10020: { id: number; state: string }[]; customfield_10016: number | null } }[] };

    // when
    const boards = await get<{ values: { id: number; name: string; type: string }[] }>("/rest/agile/1.0/board?projectKeyOrId=HOO");
    const board = boards.body.values[0]!;
    const configuration = await get<{ columnConfig: { columns: { name: string }[] } }>(`/rest/agile/1.0/board/${board.id}/configuration`);
    const active = await get<{ values: { id: number; name: string; state: string }[] }>(`/rest/agile/1.0/board/${board.id}/sprint?state=active`);
    const sprint = active.body.values[0]!;
    const inSprint = await get<Issues>(`/rest/agile/1.0/sprint/${sprint.id}/issue`);
    const backlog = await get<Issues>(`/rest/agile/1.0/board/${board.id}/backlog`);
    const byJql = await get<Issues>(`/rest/api/3/search/jql?jql=${encodeURIComponent(`sprint = ${sprint.id} ORDER BY rank`)}`);
    const open = await get<Issues>(`/rest/api/3/search?jql=${encodeURIComponent("sprint in openSprints()")}`);
    const unread = await get<unknown>(`/rest/api/3/search?jql=${encodeURIComponent("assignee = currentUser()")}`);
    const moved = await fetch(`${jira.url}/lab/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "HOO-414", status: "In Dev" }) });
    const after = await get<Issues>(`/rest/agile/1.0/sprint/${sprint.id}/issue`);
    await fetch(`${jira.url}/lab/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "HOO-414", status: "Ready for Dev" }) });
    const offered = await get<{ transitions: { id: string; name: string }[] }>("/rest/api/3/issue/HOO-413/transitions");
    const toReview = offered.body.transitions.find((t) => t.name === "Code Review")!;
    const transition = (token: string) =>
      fetch(`${jira.url}/rest/api/3/issue/HOO-413/transitions`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${jira.email}:${token}`).toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify({ transition: { id: toReview.id } }) });
    const byReader = await transition(jira.token);
    const byWriter = await transition(jira.writeToken!);
    const reviewed = await get<{ fields: { status: { name: string } } }>("/rest/api/3/issue/HOO-413");
    const made = ((await (await fetch(`${jira.url}/lab/transitions`)).json()) as { transitions: { key: string; from: string; to: string }[] }).transitions.filter((t) => t.key === "HOO-413");
    await fetch(`${jira.url}/lab/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "HOO-413", status: "Ready for Dev" }) });

    // then
    expect([board.name, board.type]).toEqual(["Customers board", "scrum"]);
    expect(configuration.body.columnConfig.columns.map((c) => c.name)).toEqual(["Ready for Dev", "In Dev", "Code Review", "Ready for Test", "In Test", "Test Passed", "Done"]);
    expect([sprint.name, sprint.state]).toEqual(["Customers Sprint 14", "active"]);
    expect(inSprint.body.issues.map((i) => i.key)).toEqual(["HOO-412", "HOO-413", "HOO-414"]);
    expect(inSprint.body.issues.map((i) => [i.fields.customfield_10020[0]?.id, i.fields.customfield_10016, i.fields.status.statusCategory.key])).toEqual([[sprint.id, 5, "new"], [sprint.id, 3, "new"], [sprint.id, 2, "new"]]);
    expect(backlog.body.issues.map((i) => i.key)).toEqual(["HOO-415", "HOO-416"]);
    expect([byJql.body.issues.map((i) => i.key), open.body.total]).toEqual([["HOO-412", "HOO-413", "HOO-414"], 3]);
    expect(unread.status).toBe(400);
    expect(moved.status).toBe(200);
    expect(after.body.issues.find((i) => i.key === "HOO-414")?.fields.status).toMatchObject({ name: "In Dev", statusCategory: { key: "indeterminate" } });
    expect(offered.body.transitions.map((t) => t.name)).toEqual(["In Dev", "Code Review", "Ready for Test", "In Test", "Test Passed", "Done"]);
    expect([byReader.status, byWriter.status, reviewed.body.fields.status.name]).toEqual([403, 204, "Code Review"]);
    expect(made.map((t) => [t.from, t.to])).toEqual([["Ready for Dev", "Code Review"]]);
  });

  test("given the stand-in OAuth MCP server, when a client follows its 401 to sign in with PKCE and calls a tool, then the call is recorded under the person who allowed it, and a refresh token gives a new access token once", async () => {
    // given
    const base = lab.mcpOauth!.url;
    const rpc = (token: string | null, body: unknown) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

    // when it is called without a token
    const unauthorized = await rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const metadata = /resource_metadata="([^"]+)"/.exec(unauthorized.headers.get("www-authenticate") ?? "")?.[1];
    const resource = (await (await fetch(metadata!)).json()) as { authorization_servers: string[] };
    const server = (await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as { registration_endpoint: string; authorization_endpoint: string; token_endpoint: string };
    const redirect = "http://127.0.0.1:1/callback";
    const client = (await (await fetch(server.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "lab check" }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const params = { client_id: client.client_id, redirect_uri: redirect, response_type: "code", state: "s1", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", person: lab.orgs[0]!.users[0]!.email };
    const allowed = await fetch(server.authorization_endpoint, { method: "POST", body: new URLSearchParams(params), redirect: "manual" });
    const code = new URL(allowed.headers.get("location")!).searchParams.get("code")!;
    const tokens = (await (await fetch(server.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect }) })).json()) as { access_token: string; refresh_token: string };
    await rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    const called = (await (await rpc(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "getIssue", arguments: { key: "VAN-321" } } })).json()) as { result: { content: { text: string }[] } };
    const renewed = await fetch(server.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }) });
    const reused = await fetch(server.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }) });

    // then
    expect(unauthorized.status).toBe(401);
    expect(called.result.content[0]!.text).toContain("VAN-321: Return the import batch size");
    const { calls } = (await (await fetch(`${base}/lab/calls`)).json()) as { calls: { person: string; tool: string }[] };
    expect(calls.at(-1)).toMatchObject({ person: params.person, tool: "getIssue" });
    expect([renewed.status, reused.status]).toEqual([200, 400]);
  });

  test("given the stand-in Google, Microsoft and GitHub, when a person picks themselves on each one's page and the client redeems the code with its secret and PKCE verifier, then Google and Microsoft give a signed ID token in their own claims, GitHub gives a token its API answers to, and a wrong secret, a wrong verifier, a reused code and an unregistered redirect are refused", async () => {
    // given
    const signIn = lab.signIn!;
    type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
    const pkce = () => {
      const verifier = randomBytes(32).toString("base64url");
      return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
    };
    /** The person's part: open the provider's page, press the button with their name, and read the code from where it sends the browser. */
    const consent = async (authorize: string, params: Record<string, string>, name: string) => {
      const page = await (await fetch(`${authorize}?${new URLSearchParams(params)}`)).text();
      const person = new RegExp(`name="person" value="([^"]+)">Continue as ${name}`).exec(page)![1]!;
      const back = await fetch(authorize, { method: "POST", body: new URLSearchParams({ ...params, person }), redirect: "manual" });
      return new URL(back.headers.get("location")!);
    };
    const claimsOf = async (idToken: string, jwksUri: string) => {
      const [header, payload, signature] = idToken.split(".");
      const { keys } = (await (await fetch(jwksUri)).json()) as { keys: JsonWebKey[] };
      const key = createPublicKey({ key: keys[0]!, format: "jwk" });
      const valid = verify("sha256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature!, "base64url"));
      return { valid, claims: JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown> };
    };

    for (const provider of ["google", "microsoft"] as const) {
      // when
      const discovery = (await (await fetch(`${signIn.url}/${provider === "google" ? "google" : "microsoft/common/v2.0"}/.well-known/openid-configuration`)).json()) as Discovery;
      const client = signIn.clients[provider][0]!;
      const { verifier, challenge } = pkce();
      const params = { client_id: client.id, redirect_uri: TEST_REDIRECT, response_type: "code", scope: "openid email profile", state: "s-1", nonce: "n-1", code_challenge: challenge, code_challenge_method: "S256" };
      const back = await consent(discovery.authorization_endpoint, params, provider === "google" ? "Ada Okafor" : "Cem Aydin");
      const redeem = (code: string, secret: string, codeVerifier: string) =>
        fetch(discovery.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: TEST_REDIRECT, client_id: client.id, client_secret: secret, code_verifier: codeVerifier }) });
      const code = back.searchParams.get("code")!;
      const wrongSecret = await redeem(code, "not-the-secret", verifier);
      const otherBack = await consent(discovery.authorization_endpoint, params, provider === "google" ? "Ada Okafor" : "Cem Aydin");
      const wrongVerifier = await redeem(otherBack.searchParams.get("code")!, client.secret, pkce().verifier);
      const thirdBack = await consent(discovery.authorization_endpoint, params, provider === "google" ? "Ada Okafor" : "Cem Aydin");
      const good = (await (await redeem(thirdBack.searchParams.get("code")!, client.secret, verifier)).json()) as { id_token: string; access_token: string };
      const reused = await redeem(thirdBack.searchParams.get("code")!, client.secret, verifier);
      const unregistered = await fetch(`${discovery.authorization_endpoint}?${new URLSearchParams({ ...params, redirect_uri: "http://127.0.0.1:2/elsewhere" })}`);
      const { valid, claims } = await claimsOf(good.id_token, discovery.jwks_uri);

      // then
      expect([back.searchParams.get("state"), wrongSecret.status, wrongVerifier.status, reused.status, unregistered.status], provider).toEqual(["s-1", 401, 400, 400, 400]);
      expect(valid, provider).toBe(true);
      if (provider === "google") {
        expect(claims).toMatchObject({ iss: discovery.issuer, aud: client.id, sub: "104857600123456789012", email: "ada@okafor-labs.example.invalid", email_verified: true, hd: "okafor-labs.example.invalid", nonce: "n-1" });
      } else {
        expect(discovery.issuer).toContain("{tenantid}");
        expect(claims).toMatchObject({ ver: "2.0", iss: discovery.issuer.replace("{tenantid}", String(claims.tid)), aud: client.id, oid: "3f2b9d1a-6c4e-4b8f-a7d2-1e5c9b0a4f63", email: "cem@aydin-works.example.invalid", xms_edov: true, nonce: "n-1" });
      }
    }

    // when GitHub's person signs in
    const github = signIn.clients.github[0]!;
    const back = await consent(`${signIn.url}/github/login/oauth/authorize`, { client_id: github.id, redirect_uri: TEST_REDIRECT, scope: "read:user user:email", state: "g-1" }, "Ben Ortiz");
    const exchange = (accept: string) =>
      fetch(`${signIn.url}/github/login/oauth/access_token`, { method: "POST", headers: { accept }, body: new URLSearchParams({ client_id: github.id, client_secret: github.secret, code: back.searchParams.get("code")!, redirect_uri: TEST_REDIRECT }) });
    const answered = (await (await exchange("application/json")).json()) as { access_token: string };
    const again = new URLSearchParams(await (await exchange("*/*")).text());
    const api = (path: string, token = answered.access_token) => fetch(`${signIn.url}/github/api${path}`, { headers: { authorization: `Bearer ${token}` } });
    const user = (await (await api("/user")).json()) as { login: string; id: number; email: string | null };
    const emails = (await (await api("/user/emails")).json()) as { email: string; primary: boolean; verified: boolean }[];
    const forged = await api("/user", "gho_not-a-token");

    // then
    expect(answered.access_token).toMatch(/^gho_/);
    expect(again.get("error")).toBe("bad_verification_code");
    expect([user.login, user.id, user.email]).toEqual(["ben-ortiz", 4401, "ben@ortiz-builds.example.invalid"]);
    expect(emails).toEqual([{ email: "ben@ortiz-builds.example.invalid", primary: true, verified: true, visibility: "public" }]);
    expect(forged.status).toBe(401);
    const { logins } = (await (await fetch(`${signIn.url}/lab/logins`)).json()) as { logins: { provider: string; person: string }[] };
    expect(logins.filter((l) => l.provider === "github").map((l) => l.person)).toContain("4401");
  });

  test("given the stand-in GitHub's issues on a team's repository, when they are listed and read with the forge token, then open issues come with their status labels and the pull requests among them, a label narrows the list, closed ones are listed on asking, and one issue and its comments read", async () => {
    // given
    const forge = lab.forges.find((f) => f.kind === "github")!;
    const get = async <T>(path: string) => (await (await fetch(`${forge.api}/repos/initech/web-skills${path}`, { headers: { authorization: `Bearer ${forge.token}` } })).json()) as T;
    type Listed = { number: number; state: string; labels: { name: string }[]; pull_request?: unknown }[];

    // when
    const open = await get<Listed>("/issues?state=open&per_page=100");
    const ready = await get<Listed>(`/issues?labels=${encodeURIComponent("status: ready")}`);
    const all = await get<Listed>("/issues?state=all&per_page=100");
    const one = await get<{ number: number; title: string; comments: number }>("/issues/101");
    const comments = await get<{ body: string }[]>("/issues/101/comments");
    const labels = await get<{ name: string }[]>("/labels");

    // then
    const issues = open.filter((i) => !i.pull_request);
    expect(issues.map((i) => [i.number, i.labels.find((l) => l.name.startsWith("status: "))?.name])).toEqual([[105, undefined], [103, "status: in review"], [102, "status: in progress"], [101, "status: ready"]]);
    expect(ready.map((i) => i.number)).toEqual([101]);
    expect(all.filter((i) => !i.pull_request && i.state === "closed").map((i) => i.number)).toEqual([104]);
    expect([one.title, one.comments, comments.map((c) => c.body)]).toEqual(["Expose the order-history endpoint to customers", 1, ["Page it by 20."]]);
    expect(labels.map((l) => l.name)).toEqual(["bug", "customer-api", "status: in progress", "status: in review", "status: ready"]);
  });
});
