#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 22.04/24.04 server (Oracle Cloud
# "Always Free" ARM VM or any other). Safe to run again.
#   bash deploy/free-tier/setup-server.sh
set -euo pipefail

echo "▸ Packages: Docker, git, gpg, rclone, automatic security updates"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"
sudo apt-get update -y
sudo apt-get install -y git gnupg rclone unattended-upgrades iptables-persistent
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

echo "▸ Firewall: allow HTTP/HTTPS (Oracle's Ubuntu images only allow SSH)"
allow() {
  if ! sudo iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null; then
    local reject
    reject=$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ { print $1; exit }')
    if [ -n "$reject" ]; then sudo iptables -I INPUT "$reject" -p "$1" --dport "$2" -j ACCEPT
    else sudo iptables -A INPUT -p "$1" --dport "$2" -j ACCEPT; fi
  fi
}
allow tcp 80
allow tcp 443
allow udp 443
sudo netfilter-persistent save

echo "▸ Backups: passphrase and nightly job"
sudo mkdir -p /etc/rof /var/backups/rof
sudo chmod 700 /etc/rof /var/backups/rof
if ! sudo test -f /etc/rof/backup-passphrase; then
  openssl rand -base64 48 | sudo tee /etc/rof/backup-passphrase >/dev/null
  sudo chmod 600 /etc/rof/backup-passphrase
  echo "  New backup passphrase in /etc/rof/backup-passphrase."
  echo "  COPY IT TO YOUR PASSWORD MANAGER NOW — backups can't be restored without it."
fi
here="$(cd "$(dirname "$0")" && pwd)"
# 01:30 UTC = 03:30 in Kigali.
echo "30 1 * * * root bash $here/backup.sh >> /var/log/rof-backup.log 2>&1" | sudo tee /etc/cron.d/rof-backup >/dev/null

echo "✓ Done. Log out and back in (for the docker group), then follow README.md step 5."
