# Skill use

## AI-assisted requests

**AI requests**, a page under `/<organization>/activity/` that the search finds, shows how many of the requests merged into each team repository a
coding agent helped write, and how long they took to merge beside the others, over 7, 30 or 90
days, per team and per repository; owners and admins also see it per person.

It is read from the history the orchestrator already mirrors, at each look, and from nothing else: no
teammate's machine sends anything for it and nothing is stored. A merged request is a merge
commit that names its merge request (`See merge request group/project!12`, GitLab) or pull
request (`Merge pull request #12 from ...`, GitHub), or a commit squashed with the number at the
end of its title (`... (#12)`). It is AI-assisted when one of its commits carries an agent's
trailer or closing line: Claude Code (`Co-Authored-By: Claude`, `Generated with Claude Code`),
GitHub Copilot, Cursor or Codex. Hours to merge run from the request's first commit to its
merge, so a squash, which keeps no first commit, is left out of them. The numbers are a floor:
an agent that leaves no trailer, a fast-forward merge and a squash without its number are not
counted. A person is named by the commit author's name and address; one that reads like a secret
is withheld.

## Skill use

The skills table can show, next to what a team ships, how often each skill was used. A team
admin or owner opens a request that adds `usage.endpoint` to the team's `.teamhandbook.json`;
this needs `ORCHESTRATOR_PUBLIC_URL`, the address teammates' machines reach. Once the request is
merged, each teammate's TeamHandbook asks them once per session to agree. It sends nothing
until they name that exact address in their own config. After that it sends only a team
skill's name and the hour it was used, once per turn.

Once a team reports, the same place offers two more requests:

- **A new usage address.** The orchestrator stops accepting the old id as soon as that request
  opens, so a leaked address stops counting at once, and counts resume when it is merged. An
  agreement covers one exact address, so every teammate is asked again.
- **Stop asking.** It takes `usage` out of the team file, and the orchestrator stops accepting the
  address as soon as the request opens, so a teammate's copy that has not updated counts
  nothing; the counts already kept stay. It
  needs no `ORCHESTRATOR_PUBLIC_URL`.

The setup panel compares the address the team file names with the one this orchestrator issued.
It warns when the file names another orchestrator, or an id this orchestrator replaced or never issued,
since every count teammates send then goes nowhere.

The receiver, `POST /ingest/usage/<id>/<repository>`, is the one route besides sign-in that
takes requests nobody signed in for, so it accepts little:

- an id issued for that one repository;
- only skill names the repository ships;
- hours within the last month;
- at most 500 events and 64 KB per request, and 60 requests a minute per id.

It keeps a count per skill and hour: no address, user, machine or session.
