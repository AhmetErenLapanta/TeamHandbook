## Backup, restore and upgrades

An orchestrator's state is its data volume (`/data`, or `ORCHESTRATOR_DATA_DIR`) and, with Postgres,
its database:

- `orchestrator.db`, the SQLite database, when there is no `ORCHESTRATOR_DATABASE_URL`;
- the team repositories the orchestrator reaches by path (`file://` URLs, the local forge),
  such as the demo's `/data/demo/repos`; nothing else holds their requests' branches;
- the mirrors, which a start reads again from each repository the file lists when they are
  missing; one the file no longer lists says its copy is missing until it is listed again.

`ORCHESTRATOR_SECRET_KEY` is in neither: keep it with your other secrets. An orchestrator restored
without it shows a forge token as set and refuses a change to that repository with "a forge
token is stored for this repository, but ORCHESTRATOR_SECRET_KEY is not set"; with another key, it
refuses with "does not open". Saving the token again under the key in use clears either.

An upgrade to the orchestrator that parts roles from team ownership moves the database up once:
every admin becomes an owner and every team owner a member who keeps their teams. Behind
https the session cookie is renamed `__Host-...` in the same release, so everyone signs in
once more after it.

Stop the orchestrator for the copy, so the database and the repositories it names agree. With the
compose file, whose project names the volume (`docker volume ls` shows it):

```sh
docker compose stop orchestrator
docker compose exec postgres pg_dump -U orchestrator -d orchestrator -Fc > orchestrator.dump   # Postgres only
docker run --rm -v orchestrator_orchestrator-data:/data -v "$PWD":/backup --entrypoint tar orchestrator-orchestrator \
  czf /backup/orchestrator-data.tgz -C /data .
docker compose start orchestrator
```

To restore, on the same machine or another, into an empty volume and, with Postgres, a
database the `postgres` service has just created:

```sh
docker volume create orchestrator_orchestrator-data
docker run --rm -v orchestrator_orchestrator-data:/data -v "$PWD":/backup --entrypoint tar orchestrator-orchestrator \
  xzf /backup/orchestrator-data.tgz -C /data
docker compose --profile postgres up -d --wait postgres                           # Postgres only
docker compose exec -T postgres pg_restore -U orchestrator -d orchestrator --no-owner < orchestrator.dump
ORCHESTRATOR_SECRET_KEY=... docker compose up -d orchestrator
```

Start it with the environment it ran with: `ORCHESTRATOR_CONFIG` (without it no repository is
synced), and on Postgres `ORCHESTRATOR_DATABASE_URL` and `--profile postgres` as well. Without the URL the restored volume opens as a new SQLite
install, empty and asking for a setup code. The `tar` steps run in the orchestrator image, so on a
new machine `docker compose build` comes first; any image with `tar` serves as well.

Tried as written on the demo with the stand-in agent, on SQLite and on Postgres: after the
volume (and the database) was deleted and restored, the orchestrator listed the same requests,
tasks and skill use, and a change to a hosted repository opened its sealed token with the
same key.

**Copies while it runs.** The orchestrator also copies itself without stopping. Each copy is a
directory `backup-<time>` under `ORCHESTRATOR_BACKUP_DIR` (`backups` in the data directory by
default), readable by the orchestrator's own user alone, holding:

- `orchestrator.db`, the SQLite database read as one snapshot (`VACUUM INTO`), with writes going on;
- a git bundle of every repository reached by path, its branches and the descriptions the local
  forge keeps as notes, each taken while no write to that repository is under way;
- `manifest.json`, naming the schema, why the copy was taken and which bundle is which
  repository.

The database is copied first and the repositories after, so a request opened in between leaves
at most a branch the copied database does not name, which the next start moves aside to
`refs/orchestrator/orphaned/` rather than losing. A copy is taken every `ORCHESTRATOR_BACKUP_HOURS` hours,
and at once when the orchestrator gets `SIGUSR2` (`docker compose kill -s SIGUSR2 orchestrator`); the
log says where it went. The newest `ORCHESTRATOR_BACKUP_KEEP` copies are kept. A copy cut off by a
stop is left as `.partial` and removed by the next one. On Postgres the copy holds the
repositories alone: back the database up with `pg_dump`, which reads one consistent snapshot
while the orchestrator runs, so it needs no stop either (`docker compose exec postgres pg_dump -U
orchestrator -d orchestrator -Fc > orchestrator.dump`).

To restore from a copy, stop the orchestrator, put `orchestrator.db` in the data directory in place of
the one there (and remove `orchestrator.db-wal` and `orchestrator.db-shm`), and recreate each repository
from its bundle at the path the manifest names, into an empty directory:
`git clone --mirror <copy>/repos/1.bundle /data/demo/repos/payments-skills.git`. Then start
the orchestrator with the same `ORCHESTRATOR_SECRET_KEY`.

**Moving from SQLite to Postgres.** An install that started on SQLite moves its database
with `migrate-store`, while the orchestrator is stopped:

```sh
docker compose stop orchestrator
docker compose --profile postgres up -d --wait postgres
docker compose run --rm orchestrator migrate-store --from sqlite:/data/orchestrator.db --dry-run
docker compose run --rm orchestrator migrate-store --from sqlite:/data/orchestrator.db
```

The target is the database `ORCHESTRATOR_DATABASE_URL` names in the orchestrator's environment, the one it
runs on afterwards; it is never given on the command line, where its password would be shown to
every process on the machine and kept in the shell's history, and `--to` is refused. Outside the
image it is `ORCHESTRATOR_DATABASE_URL=... node dist/server.js migrate-store ...` with the same flags. It
refuses while an orchestrator runs on the data directory or on the target for one of the
organizations, when the SQLite file is at an older schema (start the current orchestrator on it
once first), and when the target already holds a row of one of the organizations; another
organization's rows there are left alone. Everything happens in one transaction on the
target: the tables are created, every row is copied, and each table's count is read back per
organization and compared with SQLite's. A mismatch, a row Postgres refuses or a run that is
stopped rolls all of it back, so the target is as it was. `--dry-run` does the same and rolls
back at the end. The SQLite file is opened read-only and left as it was: starting the orchestrator
without `ORCHESTRATOR_DATABASE_URL` goes back to it. Afterwards start the orchestrator with
`ORCHESTRATOR_DATABASE_URL` set to the target, the same data volume (the mirrors and `file://`
repositories stay there) and the same `ORCHESTRATOR_SECRET_KEY`, which the sealed tokens need.

**Checking a stopped orchestrator's data.** `node dist/server.js doctor` (`docker compose run
--rm orchestrator doctor` in the image) looks over the data directory of an orchestrator that is not
running, and refuses beside one that is. It reads the database's schema against the image's, a
SQLite file's integrity and the space a `VACUUM` gives back, how fresh the orchestrator's own
copies are against `ORCHESTRATOR_BACKUP_HOURS`, and the task directories a stopped orchestrator left.
Each finding comes with the line that sets it right, and a problem ends it with exit code 1.
`--fix` does the one repair that needs no running orchestrator, reclaiming a SQLite database's
free pages; what a start sets right, such as a stopped task and its directories, is left to the
start.

**Upgrading.** Take a backup, then start the new image on the same volume and database. On
SQLite the new image also copies the database before it moves its schema, to
`before-schema-<new>-<time>.db` in the backups directory, and says so in its log; if that copy
is not written the orchestrator stops with the reason and leaves the database as it was. On Postgres
it says in its log that the schema moves and that a `pg_dump` taken before is the way back.
Tables and columns a later version adds are created when it opens the database. The database
keeps the schema version of the newest orchestrator that opened it, and an older orchestrator started
on it afterwards stops with "this database was last opened by a newer orchestrator (schema N; this
one reads up to M); start the newer image again, or restore the backup taken before the
upgrade". Images from before that record do not check; going back to one of them works while
the schema is the same. Tried with an image built before the record, on SQLite and Postgres:
the newer image showed the database it had written unchanged, the older one read it again
after, and a database marked with a later schema stopped the newer image with exit code 1 and
the message above.

Each schema step is marked `expand` (it adds a table, a nullable column or an index) or
`contract` (it drops, renames or tightens), and the database records the oldest schema that
still reads it. An older orchestrator started on a database a newer one moved reads it as it is
when every step since its own only adds, and says so in its log; after a `contract` step it
stops with the message above. `node dist/server.js migrate` (`docker compose run --rm orchestrator
migrate` in the image) moves a Postgres database named by `ORCHESTRATOR_DATABASE_URL` or its `_FILE`
to the image's schema and exits, holding no organization, so it runs while the release before
goes on serving: it prints the plan (`schema: the database is at N, this image writes M`),
`--check` stops there, and a `contract` step is refused without `--contract`, to be run once no
older orchestrator serves. Under `ORCHESTRATOR_MODE=cloud` an orchestrator never moves the schema at start: on a
database behind its own it stops and says to run `migrate` first. An orchestrator on SQLite moves its
own at start, as above.
