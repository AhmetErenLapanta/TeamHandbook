---
description: Set up the team's shared skills repository, one person, once: scaffolds that repo as a Claude Code plugin marketplace, opens a merge request with the scaffold, and prints the message the rest of the team needs. Run it only when no team repo exists yet; if one already does, join it instead. Triggers: "start a shared skill repo for us", "I am setting this up for my team", "create the team handbook repository", "we need one central place for our skills", "I will be the one who sets it up".
argument-hint: [optional SSH URL of an empty git repo]
---

You are running TeamHandbook's team setup. ONE person on a team runs this ONCE: it
scaffolds their skills repository - a Claude Code plugin marketplace where approved skills
get merged and distributed - opens a merge request with the scaffold, and records the repo
URL locally. Everyone else runs the join or /plugin commands the output prints; nobody else
runs this command.

Never ask the user for a branch or commit prefix up front. Most repositories need none, and
asking everybody about a rule that affects a minority is how a two-command setup becomes a
form to fill in. Run it plainly, and only if the forge refuses, ask - the refusal says
exactly what the rule is.

1. Determine the target repository:
   - If the user provided a git URL ($ARGUMENTS), use it. It may be empty or already have files in it: the scaffold is added alongside whatever is there, and any file that already has content is left alone.
   - Otherwise ask the user whether they already created an empty repo (ask for its SSH
     URL) or want one created now. For creation, check `which gh` and `which glab`; ask
     which namespace/group and repo name to use and confirm visibility (default private),
     then create it, e.g. `gh repo create <ns>/<name> --private` or
     `glab repo create <ns>/<name> --private`, and use the new repo's SSH URL. If neither
     CLI is installed, ask the user to create an empty repo in their forge's web UI and
     paste its SSH URL.
2. Confirm the final target URL with the user before touching it.
3. Run it once with no message flag: `node "${CLAUDE_PLUGIN_ROOT}/dist/init.js" <url>`
   (add `--name <n>` only if the user wants the marketplace named differently than the
   repo). Nothing is committed or pushed by that run. It prints the message it proposes -
   `chore: scaffold team skill base`, with the team's prefix in front if one was given -
   and the fingerprint that goes with it. Show the user that sentence; they approve it,
   edit it, or say you decide. Then run the same command again with their answer:
   `--message "<their wording>"`, or `--delegate-message <fingerprint>` if they said you
   decide. Never write a message yourself and pass it as `--message`: that flag means the
   words are the user's. **If that first run offers no `--delegate-message` at all**,
   delegating is not available here and the same sentence says why: an empty repository,
   where the scaffold goes straight to the default branch and there is no merge request for
   the delegation to be about, or a machine with no `gh`/`glab` signed in. In both, ask the
   user for the wording.
4. **If it fails because the forge refuses the branch NAME**, the error quotes the pattern
   the project requires. Do not hand the user a flag to work out. Read the pattern, propose
   ONE prefix that satisfies it, and ask them to confirm or correct it with a
   multiple-choice question - for a pattern like
   `((^(TEAM|OPS|ENG|SEC)-\d+(-[a-z0-9]+)*)|dev|master|prod|hotfix(.*))$` a working prefix is
   `TEAM-1-`, and the repo's existing branches or recent commit messages usually show which
   key the team really uses. Then re-run with `--branch-prefix "<their answer>"`.
5. **If it then fails because the forge refuses the commit MESSAGE**, do the same with
   `--commit-prefix "<prefix>"`. Both are remembered, so every skill shared later uses them
   without asking again.
6. **If it fails for any other reason** - credentials, access, a protected branch - relay
   the error as-is and stop. Those need a person, not a retry.
7. Relay the CLI output verbatim - it contains the message to send teammates.
8. Do not add `--with-ci` unless the user asks for a version-bump job by name. The scaffold
   writes no version into `.claude-plugin/plugin.json`, so Claude Code versions the plugin by
   commit and every merge - a skill's request or a commit made by hand - reaches teammates
   with no CI, no access token, and no right to push to a protected branch. `--with-ci`
   starts the repository at a version instead, and that job raises it on every merge.
9. **If the user says who should review the team's requests, or how they are labelled**, add
   `--reviewers <a,b>` and `--labels <a,b>` to the run. They are recorded in
   `.teamhandbook.json`, and the scaffold's request and every later one take them as far as
   the way it is opened allows: `gh` and `glab` send both, a push GitLab opens a request
   from carries the labels and prints the reviewers to add, and a link leaves both to be
   added by hand, the result naming them. Do not ask for them otherwise, and never take the
   names from the git history or the member list.

Never create or push to a repository the user has not explicitly confirmed.

## Refreshing a repository that already exists

If a team repository is **already configured** - the user says theirs is old, a skeleton
file is missing, `/handbook:doctor` reported the scaffold behind, or the command above
refuses with "a team repository is already configured" - do not tell them to leave and
re-init. That loses the repository. Refresh it in place instead:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/init.js" --upgrade` (add `--branch-hint <name>` if
   the user named a branch earlier in this conversation, so the proposal reuses its
   ticket). It reads the repository in a throwaway clone and changes nothing, there or on
   this machine: it prints which scaffold files are missing or differ, and the diff.
   **If it refuses because the repository's scaffold was last written by a newer
   TeamHandbook**, the copy on this machine is behind, not the repository. Relay the
   refusal and tell the user to update the copy - `/plugin marketplace update teamhandbook`
   and then `/reload-plugins` - and run the plan again. Never suggest editing
   `scaffoldVersion` in `.teamhandbook.json` to get past it: that number is what stops an
   older copy from undoing a newer refresh.
2. **Relay the plan's first line before anything else.** It says who the refresh reaches
   and whether sharing waits on it; usually it does not, and the user may stop right there.
   Then relay the plan and the diff, and ask which files to refresh. A `DIFFERS` file may
   be an old scaffold or an edit the team made on purpose - `hooks/notice.mjs` and
   `README.md` are the likely ones - and nothing records which. Never pick on their behalf.
3. Send only what they chose, on the branch and with the message they chose. The plan
   printed one question for both,
   ``Branch `<name>` · message `<text>` - confirm or change either.``:
   ask it as ONE question, at the same time as you ask which files to send, and run
   `node "${CLAUDE_PLUGIN_ROOT}/dist/init.js" --upgrade --file <path> --file <path> --branch "<name>" --message "<their wording>"`
   (or `--delegate-message <fingerprint>` in place of `--message`, if they said you decide
   and the plan offered it; it offers none on a machine that cannot open the request, and
   says so). The branch is used exactly as given and is never saved as a setting. A run
   missing either answer is refused and nothing is pushed. It opens one merge request. The
   team's own skills, commands, agents and `.mcp.json` are not offered and cannot be
   written, and inside the two manifests the team's own entries - the plugin version or its
   absence, any extra plugins, the marketplace owner - are carried across rather than
   replaced.
   **If the plan asks what a branch name looks like in this repository**, ask the user once
   for one real example (`TEAM-123-short-description`, say) or let them skip it. An answer
   goes on the same run as `--branch-example "<example>"`, which records it in
   `.teamhandbook.json` for everyone; every later proposal on every teammate's machine
   takes its shape. It is an example, not a rule: do not write a pattern for them.
   **If the user wants the team's requests to arrive assigned**, the reviewers and labels
   they name go on a run as `--reviewers <a,b>` and `--labels <a,b>` (`--reviewers ""`
   records that there are none). They are written into `.teamhandbook.json` in that
   request, and every request TeamHandbook opens to the repository afterwards takes them
   as far as the way it is opened allows: `gh` and `glab` send both, a push GitLab opens a
   request from carries the labels, and a link leaves both to be added by hand.
   The names are the user's: never take them from the git history or the member list.
   There is no assignee to record: each request TeamHandbook opens with `gh` or `glab` asks
   to be assigned to whoever opens it, and the result says when that did not happen.
   Someone asking for requests "assigned to me" needs nothing from this run.
4. **Read the plan's version line back to the user rather than promising a refresh.** A
   repository whose plugin manifest carries no version is versioned by commit, and the plan
   says the merge itself is what teammates' copies update to. One that carries a version has
   it raised by the merge request, which is what makes teammates' copies pick it up - but a
   version that is not a three-part `MAJOR.MINOR.PATCH` number cannot be raised, and the plan
   says so with a `WARNING`. When it does, the fix is to set a three-part version by hand
   first; a refresh merged without one reaches nobody.
   **Only if the user asks for the repository to stop carrying a version**, run the plan
   again with `--commit-versioning`. Never add it on your own: it takes the version line out
   of the team's manifest, which a refresh does not do unasked. Read its paragraph back as
   it stands - requests already open that raise the version conflict with it and are merged
   or closed first, teammates run the two commands it prints once it is merged, and
   everyone who shares to the repository updates TeamHandbook first - and put the same
   `--commit-versioning` on the run that sends; that run sends `.claude-plugin/plugin.json`
   whether or not it is named. It is used for that run only and saved nowhere. It is
   refused on a repository that runs the version-bump job, and on one already versioned by
   commit.
5. A `NOT OFFERED` line is not a file to argue with, and naming it anyway is refused. Its
   reason says which case it is. A symbolic link on that path, or a value in
   `.teamhandbook.json` that cannot be carried across, is fixed in the repository or
   replaced on the same run with the flag the reason names. A file that embeds the team's
   commit-message prefix is withheld because neither this machine nor the repository
   records the prefix: ask the user what their forge requires at the front of a commit
   message, and if they know it, run the plan again with `--commit-prefix "<prefix>"`. Put
   the same `--commit-prefix` on the run that sends - the plan's `--file` line carries it -
   because it is used for that run only and is not saved anywhere on this machine. The
   repository's recent commit messages usually show it, but it goes on the run only once
   the user has confirmed it.
6. If the push is refused for the branch NAME, nothing reached the repository and nothing
   was retried: the error quotes the forge's own sentence and asks the same one question
   with the refused name in it. Relay the sentence, ask again with that name as the starting
   point for their edit, and run once more with the new `--branch`. If the plan or the
   refusal names an unmerged branch that already raises the plugin version, offer its two
   ways: `--version-after-open` to go past it, or stop until that branch is merged or
   closed. A commit-message refusal names its own routes, as in the setup steps above.

Note: teammates who only want to USE the team's skills (not capture their own) do not need TeamHandbook at all - they run the two built-in `/plugin` commands the CLI prints, and the team plugin ships a tiny hook that shows them new-skill notices.
