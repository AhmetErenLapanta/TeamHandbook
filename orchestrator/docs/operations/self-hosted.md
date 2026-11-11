# Run it for a team

## Ways to run it

- **Try it on this machine:** `./demo.sh`, or `docker compose up --build` in `orchestrator/` (below).
- **Run it for your team:** the same image with `ORCHESTRATOR_AUTH=local` and a secret key (below),
  on SQLite or Postgres.
- **Run it as a cloud service** that organizations sign up to: `npm run deploy:staging` to a
  host of your own, or `npm run deploy:local` to try the whole of it on one machine; see
  [docs/operations/run-as-a-service.md](../operations/run-as-a-service.md).

## Try it

```sh
cd orchestrator
docker compose up --build
```

Open http://127.0.0.1:8080. With `ORCHESTRATOR_DEMO=1`, the compose default, the container:

- seeds two stand-in team repositories inside its volume, once per volume, and connects them;
- opens requests on the orchestrator's local forge, so nothing is fetched from or sent to a
  hosted forge;
- offers the stand-in agent, and starts with one example task already waiting for review;
- runs the tasks you start in the container itself (`ORCHESTRATOR_SERVER_TASKS=1` in
  `docker-compose.yml`), so none waits for a connected machine.

`./demo.sh` does the same in one command and fills the one layer a fresh start leaves empty:
it has the Payments team ask to see skill use, merges that request, and reports three uses the
way a teammate's TeamHandbook would. Platform never asks, so the screen shows both. It prints a
short tour of the four layers; `docker compose down -v` stops it. When something else already listens on 8080, `ORCHESTRATOR_HOST_PORT=8081 ./demo.sh` (or the same variable with `docker compose up`) moves the orchestrator to that port.

**The compose demo signs everyone in as one built-in admin** (`ORCHESTRATOR_AUTH=dev-admin`). That
is why its port is bound to 127.0.0.1, and why it answers only to the loopback host names. A
real install leaves `ORCHESTRATOR_AUTH` unset. The orchestrator then starts in `local` mode, prints a
setup code to its log, and whoever enters that code on the first screen creates the first owner:

```sh
ORCHESTRATOR_AUTH=local ORCHESTRATOR_SECRET_KEY="$(openssl rand -base64 32)" docker compose up --build
docker compose logs orchestrator | grep "setup code"
```

| Layer | Screen |
|---|---|
| Signing in | [docs/screenshots/0-sign-in.png](../screenshots/0-sign-in.png) |
| What a team has | [docs/screenshots/1-inventory.png](../screenshots/1-inventory.png) |
| A change prepared as a request | [docs/screenshots/2-editing.png](../screenshots/2-editing.png), [docs/screenshots/2-requests.png](../screenshots/2-requests.png) |
| Which skills are used | [docs/screenshots/3-usage.png](../screenshots/3-usage.png) |
| A task run by an agent | [docs/screenshots/4-tasks.png](../screenshots/4-tasks.png), [docs/screenshots/4-task.png](../screenshots/4-task.png) |

With Postgres instead of SQLite:

```sh
ORCHESTRATOR_DATABASE_URL=postgres://orchestrator:orchestrator@postgres:5432/orchestrator docker compose --profile postgres up --build
```

Without Docker (Node 22.16 or later):

```sh
cd orchestrator
npm ci
npm run build
ORCHESTRATOR_DATA_DIR=data npm run demo     # seeds data/demo
ORCHESTRATOR_DATA_DIR=data ORCHESTRATOR_CONFIG=data/demo/orchestrator.json ORCHESTRATOR_AUTH=dev-admin node dist/server.js
```
