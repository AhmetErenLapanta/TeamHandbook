/**
 * A person signed in to one orchestrator, over its HTTP API: the session cookie it was given and
 * the CSRF token every change carries. The lab sets an organization up through this, and the
 * test suite uses it wherever a browser adds nothing to what is checked.
 */
export interface Reply<T = Record<string, unknown>> {
  status: number;
  json: T;
}

export class OrchestratorClient {
  private constructor(
    readonly base: string,
    readonly cookie: string,
    private csrf: string,
    private readonly bearer = "",
    /** The org of an orchestrator serving several, reached at `/api/orgs/<org>/`; none is the first org at plain `/api/`. */
    readonly org = "",
  ) {}

  /** An automation with an API key: no cookie and no CSRF token, the key in the authorization header. */
  static withKey(base: string, secret: string): OrchestratorClient {
    return new OrchestratorClient(base, "", "", secret);
  }

  static async setup(base: string, code: string, admin: { email: string; name: string }, password: string, org = ""): Promise<OrchestratorClient> {
    return OrchestratorClient.session(base, "/api/auth/setup", { code, email: admin.email, name: admin.name, password }, org);
  }

  static async signIn(base: string, email: string, password: string, org = ""): Promise<OrchestratorClient> {
    return OrchestratorClient.session(base, "/api/auth/login", { email, password }, org);
  }

  /** Someone holding another orchestrator's cookie: whatever it names, this orchestrator has to refuse it. */
  static withCookie(base: string, cookie: string): OrchestratorClient {
    return new OrchestratorClient(base, cookie, "");
  }

  private static async session(base: string, path: string, body: unknown, org = ""): Promise<OrchestratorClient> {
    const res = await fetch(`${base}${orgPath(path, org)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} on ${base} answered ${res.status}: ${await res.text()}`);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const client = new OrchestratorClient(base, cookie, "", "", org);
    const me = await client.call<{ csrf: string }>("GET", "/api/me");
    client.csrf = me.json.csrf;
    return client;
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const res = await fetch(`${this.base}${orgPath(path, this.org)}`, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...(this.csrf ? { "x-csrf-token": this.csrf } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { text };
    }
    return { status: res.status, json: json as T };
  }

  /** The same call, failing loudly on anything but a 2xx answer. */
  async ok<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const reply = await this.call<T>(method, path, body);
    if (reply.status < 200 || reply.status >= 300) throw new Error(`${method} ${path} on ${this.base} answered ${reply.status}: ${JSON.stringify(reply.json)}`);
    return reply.json;
  }
}

function orgPath(path: string, org: string): string {
  return org ? path.replace(/^\/api\//, `/api/orgs/${org}/`) : path;
}
