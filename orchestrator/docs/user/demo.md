# A three-minute demo

A folder on your machine, one sentence to an agent, and its change waiting for you as a request.
Everything runs on one machine with made-up names, and nothing is sent to a forge.

## Before you start

You need Node 22.16 or later, git, and Claude Code signed in (`claude`). The demo repository,
`parcel-pricer`, is in `orchestrator/lab/demo/parcel-pricer/`: a small Node module with no
dependencies, in which a parcel exactly at a weight limit is priced one tier too high. Copy it to a
folder of your own and make it a Git repository with no remote:

```sh
mkdir -p ~/work && cp -R orchestrator/lab/demo/parcel-pricer ~/work/
cd ~/work/parcel-pricer && git init -q && git add . && git commit -qm "Parcel pricing"
```

## The steps

| # | You do | The screen says |
|---|---|---|
| 1 | From a clone of this repository, run `npm start` (or `npx teamhandbook-orchestrator`). | The browser opens on "Give a team of agents any folder on this machine: say what needs doing, and review every change before you keep it." |
| 2 | Under **Folder name or path**, type `~/work/parcel-pricer` and press Enter. | **What should the agent do here?**, with the folder's name above it. |
| 3 | Look under the box. | No line: Claude Code is ready. If one is there, it says what to do and offers **Check again**. |
| 4 | In a terminal in the folder, run `node --test`. | The test "prices a parcel exactly at a weight limit at that tier" fails. |
| 5 | Type "In parcel-pricer, parcels exactly at a weight limit are priced one tier too high; make the failing test pass." and press **Start**. | The task's page, the agent at work. |
| 6 | Wait for **needs review**. | The change is open on the task's page: `src/price.js` alone. |
| 7 | Press **Open the request**. | The request, on branch `task/<id>`; your own working copy is as you left it until you merge. |

One click and two things typed take it from the first screen to the request. What to say at each
step, in the room's own words: the folder is yours and needs nothing set up; the agent runs as you,
behind the orchestrator's guard; nothing reaches the repository until you merge the request.

## When the live run stalls

`sh lab/demo.sh` runs the same steps on a clean machine with the stand-in agent and records them:
a screenshot a step (`NN-<step>.png`), the video of the run (`demo.webm`) and one line a step with
its time (`demo.ndjson`, `demo.txt`). Play that video instead. It exits 0 only when no step failed;
a step the screen does not offer yet is written down as skipped.
