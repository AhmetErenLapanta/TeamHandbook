# Running the orchestrator as a service: deployment design

Status: the design the release was built from. What is built is described in the README,
"Run it as a service"; where the two differ, the README and `orchestrator/deploy/` are what runs.

## What this adds, and what it leaves alone

- A provider-neutral way to run the orchestrator for many people: one VM (or a local
  "cloud-like" setup) with Docker Compose, TLS, Postgres, a web role, one or more runner
  roles and a backup job.
- `ORCHESTRATOR_MODE=cloud` turns cloud behaviour on. Without it the orchestrator starts exactly as
  it does today: one process, SQLite or Postgres, migrations at start, a generated key for a
  single-person orchestrator. Nothing in this design changes that default.
- No provider, region, domain or registry is chosen here. Nothing deploys on its own: every
  run names its target from an env file the operator writes, prints its plan, and waits for
  a yes.

## Topology

```
            :443  Caddy (TLS, ACME or internal CA for localhost)
              |
       web (ORCHESTRATOR_ROLE=web) x N        runner (ORCHESTRATOR_ROLE=runner) x M
              \                               /
               +----------- Postgres --------+
                              |
                         backup job (pg_dump on a schedule)
```

One image for every role: `orchestrator/Dockerfile` already builds a production runtime, so
`deploy/` holds no second Dockerfile. The role comes from the environment, not the image.

## Files

| Path | What it is |
|---|---|
| `deploy/docker-compose.cloud.yml` | caddy, web, runner, postgres, backup, and a one-shot `migrate` service |
| `deploy/Caddyfile` | one site block, domain from `ORCHESTRATOR_DOMAIN`; `localhost` uses Caddy's internal CA |
| `deploy/.env.staging.example`, `deploy/.env.prod.example` | variable names and safe defaults only; every secret is a `*_FILE` path |
| `deploy/deploy.sh` | the release steps below, for `ssh` targets and for the local setup |
| `package.json` | `deploy:staging`, `deploy:prod`, `deploy:local`, `deploy:rollback` call `deploy/deploy.sh` |

## The role contract (web and runner)

The task runner's owner implements `ORCHESTRATOR_ROLE`; this is the contract the deployment
relies on.

| | unset (default) | `web` | `runner` |
|---|---|---|---|
| Serves the UI and API | yes | yes | no |
| Starts and recovers tasks | yes | no | yes |
| Syncs mirrors, scans, backups of SQLite | yes | yes | its own mirrors only |
| Health | `/api/health`, `/api/health/ready` | same | same paths on an internal port, never published |
| Data directory | `/data` | its own volume | its own volume (one per runner) |
| Moves the schema at start | yes | no | no |

- Each container holds its own data directory: `holdDataDir` refuses a second orchestrator on
  one directory, and that guard stays.
- Several runners share Postgres: the tenant advisory locks already keep two from taking the
  same repository turn. A runner takes a task through the store, so two runners never start
  the same task.
- A runner stops in two steps: `SIGTERM` stops it taking new tasks, running tasks finish or
  are handed back as recoverable, then it exits. `stop_grace_period` in compose covers the
  longest task the operator allows.
- Questions for the runner's owner are listed at the end.

## Schema changes without downtime

Today an orchestrator refuses a database a newer orchestrator moved (`newerSchema`). A rolling release
needs the old web and runner to keep working on the new shape for a few minutes, and a
rollback needs the old image to start on it.

Decision: each migration is marked `expand` (adds a table, a nullable column, an index) or
`contract` (drops, renames, tightens). An orchestrator accepts a newer schema when every migration
above its own is `expand`, and refuses as it does today when any is `contract`. A `contract`
migration ships in a later release than the code that stopped using what it removes.

In `ORCHESTRATOR_MODE=cloud` a web or runner whose database is behind its code stops with "run
migrate first" instead of migrating: only the one-shot `migrate` service moves the schema,
under the existing advisory lock.

## A release, step by step

1. **Plan.** Read the target env file, print host, image tag, current tag, schema now and
   schema after. Stop without `--yes` or a typed yes.
2. **Ship the image.** Build locally, `docker save | ssh docker load`. No registry is
   needed; a registry is a later option, not a requirement.
3. **Back up.** `pg_dump` to the backup volume, named with the release. A failed dump stops
   the release with nothing changed.
4. **Migrate.** Run the `migrate` service with the new image. Expand-only between
   releases; a `contract` migration is refused unless `--contract` is passed.
5. **Web.** Start the new web next to the old one, wait for the health gate, point Caddy at
   it, stop the old one.
6. **Runner.** Start the new runner, then stop the old one with its grace period, so no
   task is cut off.
7. **Verify.** Health gate once more through Caddy over TLS. Record the tag as current and
   the one before as previous in `deploy/state` on the target.

### Health gate

`/api/health/ready` with the metrics token returns its details; the gate passes when the
answer is ready, the version matches the tag being released, and it stays so for 10 seconds.
It fails after 120 seconds. A failed gate in step 5 or 6 rolls back on its own.

### Rollback

`npm run deploy:rollback -- staging` points web and runner at the previous tag recorded on
the target. Expand-only schema changes make this safe without a restore. If the release ran
a `contract` migration, rollback stops and names the dump from step 3 as the way back; the
restore is a separate command the operator confirms.

## Secrets

- The env examples carry names and defaults only. Each secret is a file on the target
  (`ORCHESTRATOR_SECRET_KEY_FILE`, the Postgres password, the metrics token, OAuth client
  secrets), mounted read-only.
- In cloud mode the orchestrator refuses to start without `ORCHESTRATOR_SECRET_KEY`: a generated key
  on one node would leave the other nodes unable to read the vault.
- `deploy.sh` never prints an env value, only names.

## Local cloud-like setup (`deploy:local`)

The same compose file on this machine: Caddy on `https://localhost` with its internal CA,
Postgres, one web, one runner, `ORCHESTRATOR_MODE=cloud`, stand-in OAuth, forge and Jira servers
on 127.0.0.1. It runs the full release (build, backup, migrate, web, runner, verify) and a
rollback, so the steps a staging release takes are the steps tested here. Nothing leaves the
machine.

## README: "Run it as a service"

A new section in `orchestrator/README.md`: what you need (a VM with Docker, a domain, a
Postgres password, a secret key), writing `.env.staging` from the example, the first
`deploy:staging`, what each step prints, the health gate, rollback, restoring a dump,
adding a runner.

## Tests

- vitest: the expand/contract acceptance rule, the role switches in config (which role
  migrates, which starts tasks), and the plan step (current tag, schema before and after,
  refusal of a `contract` migration without the flag).
- `deploy:local` end to end: release, a release with a failing health gate that rolls back,
  and a runner stopped mid-task that hands the task back.
- No test reaches a real host, registry or provider.

## Commits, in order

1. Expand/contract marks on migrations and the acceptance rule.
2. `ORCHESTRATOR_MODE=cloud` checks (Postgres, secret key, public HTTPS URL, no migration at
   start), built on the runner owner's `ORCHESTRATOR_ROLE`.
3. `deploy/` compose, Caddyfile and env examples.
4. `deploy/deploy.sh` with plan, backup, migrate, web, runner, verify and rollback; npm
   scripts.
5. `deploy:local` with the end-to-end checks.
6. README "Run it as a service".

## Open questions for the runner's owner

- Does a runner need any port other than health? Task logs and live status: does the web
  read them from the store, or from the runner?
- How does a runner claim a task so that two runners never start the same one?
- What does `SIGTERM` do to a running task today: finish, hand back, or cut off?
