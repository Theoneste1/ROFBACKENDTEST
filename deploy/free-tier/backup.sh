#!/usr/bin/env bash
# Nightly backup (installed as a cron job by setup-server.sh; run as root):
#   1. encrypted pg_dump of the database → /var/backups/rof (7 days) and
#      R2 bucket $BACKUP_BUCKET/db (30 days);
#   2. copy of every uploaded file → $BACKUP_BUCKET/files (never deletes, so a
#      file removed by mistake can still be recovered).
# Run it by hand before every upgrade:  sudo bash deploy/free-tier/backup.sh
set -euo pipefail
cd "$(dirname "$0")"

env_get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//'; }
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENDPOINT="$(env_get S3_ENDPOINT)"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$(env_get S3_ACCESS_KEY_ID)"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$(env_get S3_SECRET_ACCESS_KEY)"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
files_bucket="$(env_get S3_BUCKET)"
backup_bucket="$(env_get BACKUP_BUCKET)"

stamp="$(date -u +%Y-%m-%dT%H%MZ)"
dump="/var/backups/rof/rof-$stamp.dump.gpg"

echo "[$stamp] database → $dump"
docker compose exec -T postgres pg_dump -U rof -d rof --format=custom --no-owner --no-privileges \
  | gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 \
        --passphrase-file /etc/rof/backup-passphrase --output "$dump"
find /var/backups/rof -name 'rof-*.dump.gpg' -mtime +7 -delete

echo "[$stamp] upload database dump and copy files to r2:$backup_bucket"
rclone copyto "$dump" "r2:$backup_bucket/db/$(basename "$dump")"
rclone delete "r2:$backup_bucket/db" --min-age 30d
rclone copy "r2:$files_bucket" "r2:$backup_bucket/files"

echo "[$stamp] done"
