## Security model

[SECURITY.md](../../../SECURITY.md), section "The orchestrator", states what the orchestrator reads, keeps,
shows, changes, sends and accepts without sign-in, each as measured. In short:

- **Sessions** are a random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` and
  named `__Host-...` behind https), stored only as its SHA-256, for twelve hours. The cookie's name carries a mark of the
  tenant, so a browser keeps a session per org, whether the orgs are served by one orchestrator or by several on one host. Every request reads the person from
  the store, so a removed account or a lowered role takes effect on their next call.
- **CSRF.** Every call that changes something carries the session's CSRF token in a header.
  Sign-in and setup take JSON only and refuse a foreign `Origin`.
- **Passwords** are scrypt (N=2^15, r=8), at least 12 characters.
- **Sign-in limits:**
  - ten attempts a minute per address, counted on the trimmed, lower-case address;
  - thirty a minute per client, and setup and SSO starts per client as well;
  - a client is its connection's address (an IPv6 one by its /64), or the one a trusted
    proxy forwards.
- **Rights.** Every write route checks the role against the team the store records for the
  repository, never a team named in the request.
- **API keys** are kept as a prefix and a SHA-256, read as their account's current role, held
  to their scopes, and refused on every route not mapped for keys, merging included. Each key
  makes at most 120 calls a minute and an account's keys 300 together; past that the answer is
  429 with `Retry-After`. Sign-in, setup and invitation links answer their own limits the same way.
- **Forge tokens** are sealed and bound to their origin, never returned, sent only in an
  authorization header and masked in every message a forge returns.
- **Host names.** Under `dev-admin` the orchestrator answers only to the loopback names, against
  DNS rebinding; elsewhere `ORCHESTRATOR_ALLOWED_HOSTS` turns on the same check.
- **What the screen withholds:**
  - an MCP server's URL that the plugin's share rule refuses;
  - environment and header values (only their names are shown);
  - the user and password in a repository URL.
- **Tenants.** Every table carries a tenant column, and every query names one.
