#!/bin/sh
# pg_dump of the orchestrator's database into /backups, run by the backup service.
#   schedule          one dump now and one every ORCHESTRATOR_PG_BACKUP_HOURS, keeping ORCHESTRATOR_PG_BACKUP_KEEP
#   once <label>      one dump named with the label, then exit; deploy.sh takes one before every release
# A dump is written as .partial and renamed when whole, so a cut-off one is never taken for a copy.
set -eu
PGPASSWORD=$(cat /run/secrets/pg_password)
export PGPASSWORD
mkdir -p /backups
chmod 700 /backups

dump() {
  name="orchestrator-$(date -u +%Y-%m-%dT%H-%M-%SZ)-$1.dump"
  pg_dump --format=custom --file="/backups/$name.partial"
  chmod 600 "/backups/$name.partial"
  mv "/backups/$name.partial" "/backups/$name"
  echo "backup: wrote $name ($(wc -c < "/backups/$name") bytes)"
}

prune() {
  keep=${ORCHESTRATOR_PG_BACKUP_KEEP:-28}
  ls -1 /backups | grep '^orchestrator-.*-scheduled\.dump$' | sort | awk -v keep="$keep" '{ names[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print names[i] }' | while read -r old; do
    rm -f "/backups/$old"
    echo "backup: removed $old, past the $keep kept"
  done
}

case "${1:-}" in
  once)
    label=${2:?once needs a label}
    case "$label" in *[!A-Za-z0-9._-]*) echo "backup: a label is letters, digits, dot, dash and underscore" >&2; exit 2 ;; esac
    dump "$label"
    ;;
  schedule)
    hours=${ORCHESTRATOR_PG_BACKUP_HOURS:-6}
    case "$hours" in '' | *[!0-9]* | 0) echo "backup: ORCHESTRATOR_PG_BACKUP_HOURS is a whole number of hours, 1 or more" >&2; exit 2 ;; esac
    trap 'exit 0' TERM INT
    rm -f /backups/*.partial
    while :; do
      dump scheduled || echo "backup: the scheduled dump was not written" >&2
      prune
      sleep $((hours * 3600)) &
      wait $!
    done
    ;;
  *)
    echo "usage: backup.sh schedule | once <label>" >&2
    exit 2
    ;;
esac
