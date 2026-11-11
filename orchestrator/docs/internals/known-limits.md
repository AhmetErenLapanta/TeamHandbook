## Known limits

- **Configuration.** A repository the file lists is changed in the file; the screen connects and
  removes only its own, and removes one the file no longer lists. One process serves the orgs
  the file lists; adding or removing one takes a restart.
- **Addresses an admin enters.** A clone address or forge API address entered on the screen is
  fetched from the orchestrator's host, so an owner or an admin reaches what that host reaches,
  internal addresses included, unless the orchestrator checks it. A repository connected from the
  screen is refused when its host resolves to this machine, a private network or a cloud's
  metadata service, unless `ORCHESTRATOR_INTERNAL_FORGE_HOSTS` names the host, and each fetch holds
  git to the address judged then. The forge's API calls resolve the host again, and a forge API
  address set on the GitLab or GitHub card of a repository the file lists is not checked.
- **Several processes.** One tenant has one orchestrator: a second one stops at start, on SQLite by
  the data directory's lock and on Postgres by the tenant's lock in the database. An orchestrator
  holds every org it serves or stops, so two orchestrators never split one org. Several orchestrators
  share one Postgres database when their orgs differ. Sign-in limits and the
  printed setup code live in the process.
- **Lockout.** Anyone who knows an address can hold its password sign-in back for a minute,
  with ten wrong attempts.
- **Hosted forges.** A request's state on GitLab or GitHub is read every `ORCHESTRATOR_SYNC_MINUTES`,
  when someone presses **Refresh**, or when the forge's signed webhook reports a merge or a
  close; a merge there happens on the forge. A GitHub branch created by another
  request at the same moment as this one leaves an unreferenced tree and commit there, which
  GitHub collects.
- **Invitations.** People are added by an admin, with a password the admin chooses or for
  SSO; there is no invitation sent by email.
- **Schema changes.** A later version adds tables and columns when it opens an older
  database; a column renamed or retyped has no migration step yet, and going back to an older
  version is refused, not undone, so a backup taken before the upgrade is the way back.
- **Issues.** `tracker.writeBack` is not built, and OpenCode gets MCP servers only behind
  `ORCHESTRATOR_OPENCODE_MCP=1`.
- **Connecting a machine.** On a team's or the cloud's orchestrator a person connects a machine
  from Settings > **Your machines**: `handbook-orchestrator runner connect` pairs it and runs the
  person's tasks until Ctrl-C, and `runner service install` keeps it running whenever they are
  logged in (see [The screens](../user/screens.md#the-screens)). A machine runs Claude Code only,
  and the orchestrator does not hand it a task over several repositories, a delegated task, a
  scaffold refresh, a repository without `memberUrl`, or one whose `.teamhandbook/environment.json`
  runs a setup or keeps the agent to a list of domains: such a task fails when the machine takes
  it, with the reason in its log, unless `ORCHESTRATOR_SERVER_TASKS=1` runs every task on the
  orchestrator itself. A task in a folder without Git on a machine lists the files it changed and
  their line counts but not their diff, as their content stays on the machine, and its undo needs
  the machine's runner to be running. A local orchestrator runs its own tasks, a folder without Git
  included.
- **Checks in a folder of several repositories.** A folder holding several repositories runs its
  task with no checks: the checks are approved and run per project, and a work folder of several
  repositories is not checked per repository yet. The task's log says so on its first lines.
- **Lessons from a task.** The lesson a kept draft writes goes to the person's own skills folder; the
  orchestrator does not record which skills the agent actually called, so a task's page says what
  it started with, not what it used, and a skill's before and after counts tasks started with it.
  On a team's orchestrator a lesson is made only while the starter's connected machine is online,
  and otherwise waits for its next scan. A line comment can be left only while a task runs or on an
  open request, and the reason for an undo exists only for a task in a folder without Git.
- **Isolation.** Process isolation is not a sandbox; untrusted work belongs in container
  isolation.
