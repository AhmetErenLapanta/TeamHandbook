## Run it as a service

`orchestrator/deploy/` runs the orchestrator in cloud mode for many organizations on one host: Caddy
in front (TLS, with a certificate from ACME), the orchestrator, Postgres and a `pg_dump` job, from
one compose file (`docker-compose.cloud.yml`). Tasks run on the machines people connect to it by
default; with `ORCHESTRATOR_SERVER_TASKS=1` in the env file the orchestrator runs them itself, each
in a container of its own through the host's Docker, with no network but its egress proxy, as
`1000:1000`; that makes the orchestrator as trusted as root on the host, so the host serves nothing
else. Nothing deploys on its own: every run names its target from an env file and waits for a typed
`yes`.

**What you need:** a host with Docker that this machine reaches over `ssh` (or this machine's
own Docker, with `ORCHESTRATOR_TARGET=local`), a domain pointing at it, and ports 80 and 443 open.

1. **Write the env file.** `cp orchestrator/deploy/.env.staging.example orchestrator/deploy/.env.staging`
   (or `.env.prod`), and set `ORCHESTRATOR_TARGET` (`ssh://user@host[:port]`), `ORCHESTRATOR_TARGET_DIR`,
   `COMPOSE_PROJECT_NAME`, `ORCHESTRATOR_DOMAIN`, the three `ORCHESTRATOR_QUOTA_*` limits and the copy
   schedule. The staging example takes certificates from Let's Encrypt's staging CA, which
   browsers do not trust. The file holds names and settings only, never a secret.

   For sign-up (see [Signing up to a cloud orchestrator](../user/people-and-access.md#signing-up-to-a-cloud-orchestrator)) set
   `ORCHESTRATOR_PRIVACY_URL`, `ORCHESTRATOR_TERMS_URL` and at least one of
   `ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_ID`, `ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_ID` and
   `ORCHESTRATOR_SIGN_IN_MICROSOFT_CLIENT_ID`; for a provider of your own, also
   `ORCHESTRATOR_SIGN_IN_GOOGLE_ISSUER`, `ORCHESTRATOR_SIGN_IN_MICROSOFT_ISSUER`, or
   `ORCHESTRATOR_SIGN_IN_GITHUB_URL` and `ORCHESTRATOR_SIGN_IN_GITHUB_API_URL`. Without them a release
   stops before it changes anything, since a cloud orchestrator nobody signs up to only looks done.
   `ORCHESTRATOR_SIGN_UP=closed` lets a release go without them on purpose. It is read by the release
   alone: the orchestrator opens sign-up whenever both addresses reach it, so an orchestrator meant to stay
   closed leaves `ORCHESTRATOR_PRIVACY_URL` and `ORCHESTRATOR_TERMS_URL` unset.
2. **Write the secrets on the host**, as files in `ORCHESTRATOR_SECRETS_DIR` (`secrets/` under
   `ORCHESTRATOR_TARGET_DIR`), each a value with no trailing newline:

   ```sh
   mkdir -m 700 secrets
   openssl rand -hex 24 | tr -d '\n' > secrets/pg_password
   printf 'postgres://orchestrator:%s@postgres:5432/orchestrator' "$(cat secrets/pg_password)" > secrets/database_url
   openssl rand -base64 32 | tr -d '\n' > secrets/secret_key
   openssl rand -hex 32 | tr -d '\n' > secrets/metrics_token
   ```

   Each provider whose client id the env file sets has its client secret in
   `secrets/sign-in/<google|github|microsoft>_client_secret`, with no trailing newline; the
   release makes `secrets/sign-in` (mode 700) and stops, naming the file, when one is missing:

   ```sh
   printf '%s' '<the client secret>' > secrets/sign-in/github_client_secret
   ```

   A release stops, naming the ones missing, before it changes anything, and stops as well when
   the directory is not mode 700 or a file in it is group- or world-writable. The files stay
   readable (644): the orchestrator's and Postgres's own users read them inside their containers, and
   the directory keeps every other account on the host out. The script prints a secret's name,
   never its value.
3. **Release**, from `orchestrator/`: `npm run deploy:staging` (or `deploy:prod`). It prints the plan
   (target, address, the image tag and the one serving now, the database's schema, and
   `sign-up: open, with <providers>` or `closed`) and waits
   for `yes`; `-- --yes` skips the question, and `-- --dry-run` prints every step and changes
   nothing. The tag is the repository's commit, with `-dirty-<hash>` when `orchestrator/` or `src/`
   has changes not committed, or `ORCHESTRATOR_RELEASE_TAG`. Then, in order:
   - the image is built here and sent to the host (`docker save | ssh docker load`), and the
     compose file, Caddyfile, backup job and env file are copied to `ORCHESTRATOR_TARGET_DIR`;
   - the group of the host's Docker socket is read and written to the env file on the host
     (`ORCHESTRATOR_DOCKER_GID`, which the compose file has no default for);
   - Postgres, the backup job and Caddy start, and Prometheus and Vector with them when the env
     file sets `ORCHESTRATOR_OBSERVABILITY=1` (below);
   - a copy is taken: a `pg_dump` named `before-<tag>`, and the orchestrator's own copy; either one
     failing stops the release with nothing else changed;
   - `migrate --check` prints what the schema change is, and `migrate` makes it; a `contract`
     step is refused without `-- --contract` (see Upgrading in [backup-restore-upgrades.md](backup-restore-upgrades.md));
   - the orchestrator of the new tag takes the old one's place. The old one stops first, since two
     orchestrators of one organization never run on one database, and Caddy holds the requests that
     arrive in between for up to `ORCHESTRATOR_PROXY_HOLD` (30 seconds), so they wait rather than
     fail: a short gap held at the proxy, not a release without one;
   - the health gate: the orchestrator answers ready, runs the new tag, and stays so for 10 seconds
     (`ORCHESTRATOR_GATE_STEADY`), within 120 (`ORCHESTRATOR_GATE_TIMEOUT`), then the public address
     answers ready over TLS through Caddy. A failed gate starts the release before it again.
   - The tag is recorded on the host as current, and the one before it as previous.
4. **Roll back** with `npm run deploy:rollback -- staging`: the previous tag serves again,
   behind the same gate. When the database moved past what that tag reads (a `contract` step),
   it is refused and names the dump to restore. `npm run deploy:status -- staging` prints the
   current and previous tags and the state of each service, and with observability on whether
   Prometheus scrapes the orchestrator (`up = 1`) and whether Vector's configuration holds, with its
   newest file.

Copies: the backup job writes a `pg_dump` every `ORCHESTRATOR_PG_BACKUP_HOURS` (6) into the
`pg-backups` volume and keeps the newest `ORCHESTRATOR_PG_BACKUP_KEEP` (28), each written whole
before it is named and readable by its owner alone; the orchestrator keeps its own copies as under
[Backup, restore and upgrades](backup-restore-upgrades.md).

**Observability.** With `ORCHESTRATOR_OBSERVABILITY=1` the release adds
`docker-compose.observability.yml`, an example to swap for what you already run: the orchestrator
needs only its `/metrics` scraped and its stdout kept.

Prometheus scrapes `/metrics` on the internal network with the metrics token; Caddy answers
`/metrics` with 404 on the public address. Its page listens on the host's
`127.0.0.1:ORCHESTRATOR_PROMETHEUS_PORT` (9090) only, reached from elsewhere through an ssh tunnel.
`observability/prometheus.yml` lists the alerts worth writing once an Alertmanager is in place:
the orchestrator not answering for 2 minutes, more than 3 failed syncs in 30 minutes, a repository
failing for 30 minutes, and more than 0.1 server errors a second.

Vector keeps the compose services' log lines (Caddy, the orchestrator, Postgres and the backup job)
in one file a day in the `orchestrator-logs` volume. Docker sends them with its fluentd driver to the
host's `127.0.0.1:ORCHESTRATOR_VECTOR_PORT` (24224); task containers send nothing, and no Docker
socket or log directory is mounted, so `docker compose logs` goes on working. The orchestrator's own
lines are JSON and redacted before they are written, and Caddy's leave out the `Authorization`
and `Cookie` headers. `observability/vector.yaml` names the sinks to send them on instead.

### Restoring a dump

A dump named `before-<tag>` holds the database as the release before `<tag>` left it. On the
host, in `ORCHESTRATOR_TARGET_DIR`, stop the orchestrator, list the dumps, and replace the database with
one. The database is dropped and created again rather than restored over, since a restore over
it leaves the tables a later release added:

```sh
export ORCHESTRATOR_IMAGE_TAG=$(awk '{print $1}' state/current)
dc() { docker compose --env-file .env -f docker-compose.cloud.yml "$@"; }
dc stop orchestrator
dc run --rm --no-deps --entrypoint sh backup -c 'ls /backups'
dc run --rm --no-deps --entrypoint sh backup -c 'export PGPASSWORD=$(cat /run/secrets/pg_password); dropdb --force orchestrator && createdb orchestrator && pg_restore --no-owner -d orchestrator /backups/<name>.dump'
```

Then `npm run deploy:rollback -- staging` from this machine starts the release before it on the
restored database, behind the health gate; to go on with the release serving now, `dc start
orchestrator` on the host instead.

### On this machine

`npm run deploy:local` runs the same compose file and the same release steps on
`https://localhost:18743` (`ORCHESTRATOR_LOCAL_HTTPS_PORT`), with Caddy's own CA, Postgres, cloud
mode, task containers with no network, the stand-in agent, the demo repositories and
observability, making the secrets once, in `ORCHESTRATOR_LOCAL_DIR`
(`$TMPDIR/teamhandbook-orchestrator-local` by default). Sign-up is open: the lab's stand-in Google,
GitHub and Microsoft run beside the orchestrator (`docker-compose.stand-ins.yml`) on
`127.0.0.1:18745` (`ORCHESTRATOR_LOCAL_STAND_INS_PORT`, always two above the https port), with
their client secrets in `secrets/sign-in`. `ORCHESTRATOR_LOCAL_SIGN_UP=closed` starts it with sign-up
closed and no stand-in providers instead.

After the release it checks the edge through Caddy over TLS: ready, `/metrics` kept off it, a
setup code, a password and a read without sign-in refused, and, with sign-up open, signing up
with the stand-in Google, creating an organization and reading `/api/me` in it as its owner. It
runs the demo task to its request in a container of its own, checks that a task container
reaches nothing, that Prometheus scrapes the orchestrator on `127.0.0.1:18790`
(`ORCHESTRATOR_LOCAL_PROMETHEUS_PORT`), and that Vector, on `127.0.0.1:18724`
(`ORCHESTRATOR_LOCAL_VECTOR_PORT`), keeps the orchestrator's lines and no task's. Nothing leaves the
machine. A second one runs beside it under its own `ORCHESTRATOR_LOCAL_PROJECT` and
`ORCHESTRATOR_LOCAL_DIR`, with ports of its own and its own `ORCHESTRATOR_LOCAL_EDGE_SUBNET` and
`ORCHESTRATOR_LOCAL_PROXY_IP`. `npm run deploy:local -- down`, with the same variables, stops it and
deletes its volumes and that directory.
