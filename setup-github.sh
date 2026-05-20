#!/usr/bin/env bash
#
# setup-github.sh — push this repo to a fresh GitHub repository.
#
# Usage:
#   ./setup-github.sh https://github.com/your-user/ai-handoff.git
#
# Steps it performs:
#   1. Confirms you're on the main branch
#   2. Adds the given URL as remote 'origin' (or updates it)
#   3. Pushes main with --follow-tags
#
# Prerequisites:
#   - A GitHub repo has been created (empty, no auto-init)
#   - You have push access (HTTPS PAT or SSH key configured)
#
set -euo pipefail

URL="${1:-}"

if [[ -z "$URL" ]]; then
  echo "Usage: $0 <github-repo-url>"
  echo "Example: $0 https://github.com/yourname/ai-handoff.git"
  exit 1
fi

CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Warning: current branch is '$CURRENT_BRANCH', not 'main'."
  read -rp "Continue anyway? [y/N] " yn
  if [[ "$yn" != "y" && "$yn" != "Y" ]]; then
    exit 1
  fi
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "Updating existing 'origin' remote..."
  git remote set-url origin "$URL"
else
  echo "Adding 'origin' remote..."
  git remote add origin "$URL"
fi

echo "Pushing to $URL ..."
git push -u origin "$CURRENT_BRANCH" --follow-tags

echo
echo "✓ Pushed successfully."
echo
echo "Next steps:"
echo "  1. Visit $URL"
echo "  2. Update the README's placeholder URLs (search for 'your-username')"
echo "  3. Create a publisher on https://marketplace.visualstudio.com/manage"
echo "     and update 'publisher' in package.json before publishing"
