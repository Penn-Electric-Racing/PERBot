#!/usr/bin/env bash
# One-time setup, run ON the Lightsail instance (Ubuntu) from inside the cloned repo:
#   git clone https://github.com/Penn-Electric-Racing/PERBot.git ~/PERBot
#   cd ~/PERBot && git checkout python && bash deploy/setup.sh
# Then put the tokens in ~/PERBot/.env (copy .env.example) and: sudo systemctl restart perbot
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
cd "$DIR"

# Python 3.11+ (Ubuntu 24.04 ships 3.12) plus venv support.
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip git

python3 - <<'EOF'
import sys
if sys.version_info < (3, 11):
    sys.exit(f'PERBot needs Python 3.11+, this instance has {sys.version.split()[0]}')
EOF

# The search index is held in memory; small instances need swap to avoid the OOM killer.
if ! swapon --show | grep -q .; then
  echo "Adding a 2 GB swap file"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
mkdir -p data

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example. Fill in the tokens before starting the bot."
fi

sed -e "s#__USER__#${USER_NAME}#g" -e "s#__DIR__#${DIR}#g" deploy/perbot.service \
  | sudo tee /etc/systemd/system/perbot.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable perbot

echo
echo "Installed the perbot service (enabled at boot, not started yet)."
echo "  1. Edit ${DIR}/.env"
echo "  2. sudo systemctl restart perbot"
echo "  3. journalctl -u perbot -f"
