## How it is built

- `server/` - Node, [Hono](https://hono.dev). `inventory.ts` reads a team repository through
  git objects in a bare mirror (`git clone --mirror`, then `git remote update`). The orchestrator
  never keeps a working tree and never runs a hook from a repository it does not own. git
  runs without the host account's global or system config, in the background
  (`server/git.ts`, `gitAsync`), so a long read or a merge does not hold up sign-in or
  anything else. An inventory reads the whole tree with one `ls-tree` and the files it needs
  with `cat-file --batch` in groups of at most 32 MiB, whatever the repository's size; a
  single file over 64 MiB is refused by name. A read the browser gives up on stops its git.
  Writes to one repository - a request's branch, a merge, a sync - take turns (`oneAtATime`),
  and a local merge is recorded as merged only after git has moved the default branch.
- Stopping and starting: on SIGTERM or SIGINT (`docker stop`, Ctrl-C) the orchestrator stops
  taking connections and waits up to 8 seconds, under the 10 `docker stop` allows, for the
  requests and repository writes under way and for running tasks. A start first sets right
  what an orchestrator that died mid-write left: a local request whose record and branch disagree
  is recorded as the repository has it, and leftover scratch directories are deleted. A branch
  the orchestrator made - its description under `refs/notes/orchestrator/<branch>` beside it, or the
  orchestrator's own prefix - and committed, that no request names - judged against every request on
  record, of any tenant, including a disconnected or renamed repository's - is moved, with its description, to
  `refs/orchestrator/orphaned/<time>/`, out of the branch list; nothing in a team repository is
  deleted, and `git update-ref` brings it back; the log names both commands. Mirrors leave
  `refs/orchestrator/` out. The orchestrator never prunes what it moved aside; once nobody needs it,
  `git for-each-ref --format='delete %(refname)' refs/orchestrator/orphaned | git update-ref --stdin`
  in the team repository clears it. That check reads two branch listings per repository,
  however many requests are on record, eight repositories at a time. Only then does the
  orchestrator serve; the mirrors are synced after that, four at a time, so a start with fifty
  repositories and 5000 requests on record answers before most of them are synced (measured
  on SQLite and Postgres). A repository read for the first time says so on its page until its
  sync lands.
- Lists that grow with a company - requests, people, a repository's skills - are shown 50
  rows at a time; requests are paged and filtered by state on the server (`/api/requests`
  takes `status`, and `after`, the `next` of the page before). A page continues after the last
  row of the one before, so a request opened, merged or closed in between neither repeats a
  row nor skips one.
- `server/plugin.ts` - the only import from the plugin's `src/lib`: how a skill's frontmatter
  is read, which MCP definitions and assignment entries travel, what a secret looks like.
  Only pure functions cross it; `guard.test.ts` fails on any other path in.
- `server/store.ts` - the store interface, one implementation over a small SQL driver, and the
  SQLite driver (`node:sqlite`). `server/store-postgres.ts` is the Postgres driver; both run
  the same statements and one contract suite.
- `server/accounts.ts`, `auth.ts`, `oidc.ts`, `passwords.ts` - accounts, sessions, roles,
  limits and single sign-on; `invites.ts` invitations and the join page, `keys.ts` API keys,
  service accounts and the routes a key reaches, `directory.ts` IdP groups and member tags,
  `privacy.ts` leaderboard visibility, task log retention and usage reporting status.
- `server/changes.ts`, `editing.ts`, `propose.ts` - what a change becomes, the routes that
  take one, and the provider it goes through (`server/forge/`: local, GitLab, GitHub).
- `server/vault.ts` - forge tokens sealed with AES-256-GCM.
- `server/ids.ts` - a record's id says what it names: `usr_` (account), `inv_` (invitation),
  `key_` (API key), `svc_` (service account), `tsk_` (task), `evt_` (event) or `pol_` (policy),
  then 26 characters of Crockford base32 in lower case, the time first, so ids sort as text in
  the order their records were made. Records made before keep their ids, since an id is written
  into branch names, event subjects and addresses. A key's or SCIM token's own text
  (`th_sk_...`, `th_scim_...`) is apart from its record's id.
- `server/work/` - Work: the sources a person reads from (`sources.ts`), Jira through its API
  (`jira.ts`) and through a person's MCP server (`mcp-jira.ts`), the per-process answer cache
  (`cache.ts`) and each issue's tasks (`links.ts`); `shared/work.ts` is the `/api/work` contract.
- `server/usage.ts` - the skill-use receiver.
- `server/tasks/` - the task runner:
  - `runner.ts`, the run in order;
  - `agents.ts`, one adapter per agent CLI;
  - `isolation.ts`, the task's directories, stripped environment, process groups and the
    docker command;
  - `changes.ts`, reading the agent's result back;
  - `redact.ts`, redacting the log.
- `web/` - React, built by Vite into `dist/web` and served by the same process; every path
  that is not an API route answers with the page, which reads the organization and section
  from the path.
- `web/src/Confirm.tsx` - `ConfirmAction` for anything that cannot be taken back (it says the
  result first, the button names the action, the way out says what is kept) and `CopyButton` /
  `CopyText` for a value shown once (where the clipboard is refused, the text is selected).
- `web/src/Status.tsx` - `Loading` and `LoadFailed`: a section says what it reads ("Loading
  skill use…", "Couldn't load skill use. <reason>", "Retry skill use"), so a page with several
  sections says which one waits or failed.
- `shared/` - the shapes the server answers with and the screens read, imported by both, and
  the CSV cell writer both exports use.
- `demo/seed.ts` - two team repositories laid out by the plugin's own scaffold.
  `demo/fake-agent.mjs` is the stand-in agent.
