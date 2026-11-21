#!/usr/bin/env bash
# Deploy the latest pushed code to the Lightsail instance over SSH. Run from your laptop:
#   PERBOT_HOST=ubuntu@<instance-ip> PERBOT_KEY=~/.ssh/LightsailDefaultKey.pem bash deploy/deploy.sh
# PERBOT_KEY is optional if the key is already in your SSH config/agent.
# PERBOT_BRANCH (default: python) and PERBOT_DIR (default: ~/PERBot) can override the defaults.
# It pulls the branch on the server, installs dependencies and restarts the service.
# Only pushed commits are deployed; local, unpushed changes are not.
set -euo pipefail

HOST="${PERBOT_HOST:?Set PERBOT_HOST, e.g. ubuntu@1.2.3.4}"
BRANCH="${PERBOT_BRANCH:-python}"
REMOTE_DIR="${PERBOT_DIR:-~/PERBot}"
SSH_OPTS=()
[ -n "${PERBOT_KEY:-}" ] && SSH_OPTS+=(-i "$PERBOT_KEY")

ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$HOST" bash -s -- "$BRANCH" "$REMOTE_DIR" <<'EOF'
set -euo pipefail
BRANCH="$1"; DIR="${2/#\~/$HOME}"
cd "$DIR"
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"
.venv/bin/pip install --quiet -r requirements.txt
sudo systemctl restart perbot
sleep 3
systemctl is-active --quiet perbot && echo "perbot is running at $(git rev-parse --short HEAD)" \
  || { echo "perbot failed to start:"; journalctl -u perbot -n 40 --no-pager; exit 1; }
EOF
