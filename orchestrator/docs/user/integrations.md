## Integrations

**Integrations** lists the services the orchestrator works with as cards, with a search box. Each
card shows its state (not set up, requested, connected) and who turned it on and when. Anyone
signed in reads the page; an admin changes the organization's integrations.

Personal and team orchestrators show the same sections and texts. On one person's own computer, the
page says under its first sentence "Your tasks use the 3 MCP servers in your Claude Code." (the
number is theirs; it says "the MCP server" for one and nothing for none), with no list, since tasks use
them as they are.

Integrations opens with **Search integrations**, then **Start here**: Jira, Linear, Notion and Sentry,
drawn as cards like the rest. On one person's own orchestrator, its owner first sees **Found on this
machine**: the MCP servers their own Claude Code has, each by its name, its kind and where it is
defined, never its command, address or any value. One named for a service Integrations knows offers
that service's own sign-in; any other is added under **Your MCP servers**, by its command or its
address, to reach the tasks they start. Nothing is read or copied from Claude Code. **Jira**'s one action is **Sign in with Atlassian**. It adds Atlassian's own
MCP server (`ORCHESTRATOR_ATLASSIAN_MCP_URL`) as your own server, named `atlassian`, allowed only
the tools that read: the sites, the projects, a search and an issue. Then it opens Atlassian's
approval screen, which lists what Atlassian asks for its MCP server; the orchestrator asks for
nothing of its own. Back on the page the card says **Connected** and how many boards Work reads,
with **Open Work**; a second press signs the same server in again. The sign-in is sealed in the
vault as yours, never shown or logged, and handed to a task from the vault when it runs. It works
the same on one person's orchestrator and a team's: each person signs in for themselves, and Jira
is read as them. Under Your MCP servers, **Disconnect** deletes the sign-in and **Remove** deletes
the server too. Nothing in Jira changes unless moving Jira issues is turned on, and a task's agent
never changes an issue. On one person's own orchestrator the sign-in returns to the address the
browser opened it at; a team's needs `ORCHESTRATOR_PUBLIC_URL` set. Without it, Start here says
"A sign-in returns to this orchestrator's own address, and none is set. Whoever runs it sets
ORCHESTRATOR_PUBLIC_URL; until then these sign-ins are off.", and every **Sign in with** button
under it is off; Jira's API token still works. Under **Other ways
to connect**, an owner or an admin can **Use an API token instead** while nobody has signed in. On
one person's own orchestrator it reads "Read Jira, Linear or GitLab issues with an API token
instead.", and **Use an API token instead** opens the issue tracker's card. Once Jira is signed in, that card waits out of the list until a
tracker is set up or the link asks for it. GitHub issues is a tracker choice in both modes.

**Linear**, **Notion** and **Sentry** each offer **Sign in with <name>**. One press
adds that service's own MCP server as your own server (named `linear`, `notion` or `sentry`) and
opens its approval screen. Back on the page, only the tools the server marks as reading are
allowed; one that writes, or one it does not mark whose name does not read, is left off. The card
then says how many tools read the service as you in tasks you start, and that nothing in it
changes, with **Choose tools**, which opens Your MCP servers. Linear is reached at its read-only
address. A sign-in that fails says the server's reason and offers adding it with a token under Your
MCP servers instead. Slack is not among them: its MCP server takes only apps registered with Slack
beforehand, so it cannot be connected in one step, and Slack notifications stay on the Slack card.

- **GitLab and GitHub.** On one person's own computer, and on a self-hosted orchestrator one person runs
  that only their machine reaches (`ORCHESTRATOR_AUTH=dev-admin`, no `ORCHESTRATOR_HOST`, one
  account), each forge card is one button, **Sign in with GitHub** or **Sign in with GitLab**. It
  starts the person's own `gh` or `glab` browser sign-in and shows its one-time code ("Enter
  ABCD-1234 on GitHub") with **Open GitHub**, then waits. Where the orchestrator has its own GitHub or GitLab.com application (its registered client ID is
  in `ORCHESTRATOR_FORGE_<GITHUB|GITLAB>_DEVICE_CLIENT_ID` or in the release), the same button gives
  a one-time code to enter on the forge's page instead: nothing to install, and the token is sealed
  for that person alone. Without the CLI or that application the card says to install the CLI,
  then **Check again**. Elsewhere the card connects the organization through the operator's OAuth
  application, with **Connect with GitHub** or **Connect with GitLab**
  ([registering them](../operations/forge-apps.md#registering-the-gitlab-and-github-apps)). Either
  way, a token is under **Other ways to connect**; the organization's own GitLab application is
  there too where the card connects the organization. Where a repository's requests open, set per repository with its
  project and token, as described under Forges and the token vault. The card lists every
  repository with where it is read from and where its requests open now. One read by its forge
  address is set up from the card, the API address and project filled in from that address. One
  read from a path on this machine opens its requests on the orchestrator's own copy, and the card
  shows the line of `ORCHESTRATOR_CONFIG` to change: its `url` to the forge address, then a restart. Everyone reads which
  repositories use each forge; the address, project and who entered the token are shown to
  owners and admins, as the forge settings are.
  With the operator's GitLab OAuth application (`ORCHESTRATOR_FORGE_GITLAB_*`) or GitHub App
  (`ORCHESTRATOR_FORGE_GITHUB_*`; [registering them](../operations/forge-apps.md#registering-the-gitlab-and-github-apps)), an owner or an admin signed in to the orchestrator, never an API key,
  connects the organization's GitLab or GitHub in the browser: `POST /api/forge/<gitlab|github>/connect`
  answers GitLab's sign-in address (the `api` scope, PKCE S256) or the app's install page on
  GitHub, and the forge returns the browser to `/integrations/forge/callback`, where the
  sign-in finishes only in the browser that began it, within ten minutes, and only for a person
  who still manages the organization. GitLab's tokens are sealed in the vault, renewed with the
  refresh token five minutes before they lapse, one renewal at a time across the orchestrator's
  processes, and the pair a new sign-in replaces is revoked. On GitHub the organization keeps
  only which installation is its own, checked with the installer's token, which is used once and
  kept nowhere; the orchestrator mints an hour's token from the app's key when it needs one.
  `GET /api/forge/<gitlab|github>/connection` names the account, who connected it and when, and
  says what the orchestrator lacks for it (the application, `ORCHESTRATOR_PUBLIC_URL`,
  `ORCHESTRATOR_SECRET_KEY`). Connecting again as another GitLab account or another GitHub installation is refused while a repository
  reaches the forge through the connection, and so is `DELETE /api/forge/<gitlab|github>/connection`,
  which otherwise asks GitLab to revoke the tokens, or on GitHub says the app stays installed
  until it is removed in that account's settings. Each connection is written to the event log.
  For a self-managed GitLab the operator's application does not reach, an owner, signed in,
  enters the organization's own GitLab OAuth application (`PUT /api/forge/gitlab/app`: its
  application ID and secret and the GitLab's https address alone); `GET /api/forge/gitlab/app`
  shows the redirect URI to register with it. The address is resolved as a connected
  repository's is, and one inside the orchestrator's network is refused unless
  `ORCHESTRATOR_INTERNAL_FORGE_HOSTS` names it. The secret is sealed in the vault, the application is
  the organization's GitLab from then on, and it is changed or removed (`DELETE`) only while
  GitLab is disconnected, since the tokens belong to the application they were made through;
  setting and removing it are written to the event log.
  Through the connection an owner or an admin, signed in and never with an API key:
  - lists the repositories it reaches (`GET /api/forge/<gitlab|github>/repos`, the 100 touched
    last): on GitLab the projects the connected person is at least a developer of, on GitHub
    the ones the app is installed on, each with whether it is empty and connected already;
  - connects one of them (`POST /api/forge/<gitlab|github>/repos/connect`, with the team, kind
    and name as under Connect repositories). Only a repository the connection lists is taken,
    since an address typed in would send the connection's token wherever it pointed. The
    repository carries no token of its own: fetches and requests use the connection's, and its
    token form is refused;
  - sets up the team's skills repository (`POST /api/forge/<gitlab|github>/team-repo`): a new
    repository (on GitLab in a group or the connected person's own namespace, on GitHub only
    when the app is installed on an organization), or one the connection lists as empty. Its
    first commit is TeamHandbook's scaffold, written straight to the default branch: the one
    place the orchestrator writes there without a request, and only on a repository it just created
    or one with no branch and no commit at all, never with force. On GitLab the scaffold is one
    commit; on GitHub the README starts the branch and the rest follows as a second commit that
    only moves the branch forward. The repository is then connected and given a webhook to the
    orchestrator (`/api/hooks/forge/<id>`, signed with a secret of its own sealed in the vault,
    needing `ORCHESTRATOR_PUBLIC_URL`), which the orchestrator takes off the forge when the repository is
    disconnected. A step that fails leaves the repository on the forge, named
    in the answer and never deleted, to be picked again as an existing empty one.

  On the screen, the GitLab and GitHub cards under Integrations do all of it for an owner or an
  admin: **Connect with GitLab** or **Connect with GitHub** (and **Reconnect** when a connection
  broke, with the reason), the repositories the connection reaches, each marked **Connected** or
  taking a team with **Connect <repository>** and, when it is empty, **Use <repository> as the
  team repository**, which
  writes the scaffold into it as above, **Create team repository** (a name, the team, the visibility,
  private by default, and on GitLab a group), and **Disconnect**, which asks first. On GitLab
  without the operator's application the card takes the organization's own (GitLab address,
  application ID and secret, with the redirect URI to register) and removes it again.
- **Slack.** Once whoever runs the orchestrator has registered a Slack app (see
  [Configuration](../operations/configuration.md#configuration)), Slack is one press, **Add to Slack**:
  Slack's own screen asks which channel, and the orchestrator posts there. Every event is chosen at first;
  edit them on the card. Without that app the card says what to register and the redirect address to
  give it. Under **Other ways to connect**, an admin pastes a channel's incoming webhook address and
  picks the events to post:
  a request opened, merged or closed, and something the orchestrator does
  on its own that stopped working or works again. The card also lists a task finished or failed,
  but the task runner does not write those to the event log yet, so nothing is posted for them.
  Reading a repository, reaching its forge (an
  unreachable forge, a refused token, a server error) and running tasks each count as broken
  after three failures in a row; it is written to the event log once, as `health.degraded`, and
  once more as `health.recovered` when it works again. A check that breaks again within six hours
  of being told is not told again, so one flapping repository does not fill a channel. The address is the credential
  and is sealed in the vault like a forge token; it has to be `https://hooks.slack.com/...`
  (plain http only on this machine, for a stand-in). Messages are posted after the event is in
  the event log and never hold up or fail the action; the card shows how the last one went.
  Texts are escaped for Slack, so a title like `<!channel>` is shown, not sent as a mention.
- **Issue tracker.** Jira, Linear, GitLab issues or GitHub issues, by the site's https address
  (Linear: the workspace's, `https://linear.app/<workspace>`). A task then names its issue by key
  (`PAY-142`, `ENG-123`, `group/project#12`, `owner/repo#12`) or by its link, and the orchestrator
  makes the link. With a read-only token (Jira: the account's email and an API token; Linear: an
  **API key** from Linear's settings; GitLab: an access token), sealed in the vault like a forge token, the orchestrator reads the issue just
  before the agent starts - title, status, description, acceptance criteria (a field whose name
  says so), sub-tasks and the five latest comments - and gives it to the agent fenced as data,
  redacted line by line as a task log is. Linear's is one GraphQL query that also reads the
  issue's priority and labels. Only an issue on the connected site is read, and on Linear only in
  the connected workspace, since an identifier such as `ENG-12` exists in every workspace; any other
  link reaches the agent as a link, unless a tool reading such issues is allowed on an MCP server
  of the starter's own or one connected for everyone's tasks: then the agent's prompt names that
  tool. The task form says which of these a link gets, for every tracker alike ("The agent reads
  the issue's text and latest comments from the tracker before it starts.", or for a link it
  cannot read, such as one to another Linear workspace, "The agent sees only the link; connect the
  issue tracker, or an MCP server that reads <tracker> issues, in Integrations."), and shows the
  issue's key, title and status as the task would read them (`GET /api/issues/preview`). A read that fails is said in the task's log and the task
  runs on with the link. Nothing else is written to an issue; moving it on its board is
  [Work](work.md#work)'s switch.
- **Your MCP servers.** Anyone signed in adds servers of their own: a remote URL, or a
  command the task runs. They reach only the tasks that person starts, with that person's
  access. **For** in the add form picks a team instead: the server is checked by the same rule
  as any team server and goes in through a request on that team's repository, which someone
  reviews and merges. A
  remote server that signs people in is connected once in the browser: the orchestrator runs the
  MCP authorization flow (protected resource metadata, dynamic client registration, PKCE
  S256), keeps the tokens sealed, and renews them before each task; **Disconnect** deletes them.
  A server that takes a static token keeps it sealed the same way. **Load tools** asks the
  server for its tools and shows them as Reads and Writes, by what the server says of each
  (`readOnlyHint`, `destructiveHint`) or else by its name; a tool that does not read as reading
  counts as writing. The first time, only the tools that surely read are ticked: the server says
  the tool only reads, or says nothing that makes it writing, and its name starts with a reading
  verb, the rule a one-step catalogue sign-in uses. Any other tool, a writing one included, waits
  unticked until the person ticks it, and a ticked writing tool is noted: "This lets a task change
  things in <server> as you". The same holds for a team server connected for everyone's tasks. A server with none picked is not given to a task. In a task the server's definition names a variable
  (`TH_MCP_<NAME>`) and the value is in the agent's environment only, masked wherever the task
  writes. A server named as one the team repository declares, at the same address, is the
  person's sign-in to the team's server: the task gets the team's definition with their
  credential. At another address the team's stays and theirs is left out. A server whose sign-in
  has lapsed is left out. The task's log says, for each, whose sign-in it came with or why it was
  left out. The team's policies hold over a person's servers as over the team's.
  The address has to be https on a public host; `ORCHESTRATOR_MCP_LOCAL=1` lets it be on this
  machine over http, for the lab's stand-ins.
- **Team MCP servers.** The servers the team repositories' `.mcp.json` declare that send no
  credential of their own - a remote server that signs people in, such as a tracker's - one
  entry per name and address, with the repositories that declare it. Anyone presses **Connect
  for my tasks**: the server is added as their own at the same address and they sign in, so the
  tasks they start reach it as them. An owner or admin presses **Connect for everyone's tasks**:
  the organization signs in once, and the card says whose account every task then acts as; it
  is written to the event log, and **Disconnect for everyone** deletes it. In a task, the
  starter's own sign-in is used first, then the organization's; with neither, the log says the
  server needs a sign-in. An owner or admin picks the tools of it everyone's tasks can call,
  grouped as Reads and Writes; a repository's `mcpTools` in the configuration are allowed besides.
- **Orchestrator MCP.** The orchestrator's own MCP server, at `<ORCHESTRATOR_PUBLIC_URL>/mcp` over Streamable
  HTTP. Turning it on for a team opens a request that adds `teamhandbook-orchestrator` to the team's
  `.mcp.json` as its address alone. The first time a teammate's Claude Code calls it, the orchestrator
  answers with where to sign in (OAuth, as the MCP authorization spec lays out: resource and
  authorization server metadata, dynamic client registration, PKCE S256), and the teammate
  approves it in the browser where they are signed in to the orchestrator. The approval page names
  the app, where it returns, the org and the person, and what it is allowed to do: read repositories,
  requests and tasks, and, if ticked, propose changes and start tasks. Access tokens last an
  hour and renew with a refresh token that is spent on use (30 days); the app revokes them at
  `/oauth/revoke`. An API key from the people settings still works, for automation and for an
  entry written before, which names a key's variable. Everyone reads repositories, open requests
  and their own tasks; someone who can change a team's repository also previews and proposes
  skill and MCP server changes and starts tasks. No tool merges or closes a request, and every
  call is written to the event log before it runs; a call the log does not take is not made.
  The sign-in needs `ORCHESTRATOR_PUBLIC_URL` and `ORCHESTRATOR_SECRET_KEY` and is off under
  `ORCHESTRATOR_AUTH=dev-admin`; the card lists whatever the orchestrator lacks.
