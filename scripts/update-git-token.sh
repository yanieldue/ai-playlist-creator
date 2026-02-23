#!/bin/bash
# Run this whenever your GitHub token expires:
#   cd /path/to/ai-playlist-creator
#   nano .env          # update GITHUB_TOKEN=ghp_...
#   ./scripts/update-git-token.sh

set -e

# Load .env from repo root
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ .env not found at $ENV_FILE"
  exit 1
fi

export $(grep -v '^#' "$ENV_FILE" | xargs)

if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_USER" ] || [ -z "$GITHUB_REPO" ]; then
  echo "❌ Missing GITHUB_TOKEN, GITHUB_USER, or GITHUB_REPO in .env"
  exit 1
fi

REMOTE_URL="https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${GITHUB_REPO}.git"

git -C "$ROOT_DIR" remote set-url origin "$REMOTE_URL"
echo "✅ Main repo remote updated"

# Update mobile repo if it has its own remote
MOBILE_DIR="$ROOT_DIR/mobile"
if git -C "$MOBILE_DIR" remote get-url origin &>/dev/null; then
  MOBILE_REMOTE=$(git -C "$MOBILE_DIR" remote get-url origin)
  # Only update if it's the same GitHub user/org
  if echo "$MOBILE_REMOTE" | grep -q "github.com/${GITHUB_USER}"; then
    MOBILE_REPO=$(basename "$MOBILE_REMOTE" .git)
    git -C "$MOBILE_DIR" remote set-url origin "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${MOBILE_REPO}.git"
    echo "✅ Mobile repo remote updated"
  fi
fi

echo ""
echo "Token updated. You can now push normally."
