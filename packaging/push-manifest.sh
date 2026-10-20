#!/usr/bin/env bash
# Commits one rendered manifest to a package-manager repository (the Homebrew tap or the Scoop bucket), from the
# release workflow's `packages` job (ADR-0104). Skips without a token, and does nothing when the file is unchanged.
#
#   TOKEN   a token that may push to REPO (fine-grained: Contents read and write on that repository only)
#   REPO    owner/name of the repository, e.g. FriendsOfKubernetes/homebrew-sextant
#   SOURCE  the rendered file
#   TARGET  its path in REPO, e.g. Casks/sextant.rb
#   TAG     the release tag, for the commit message
set -euo pipefail

if [ -z "${TOKEN:-}" ]; then
  echo "No token for $REPO: skipped"
  exit 0
fi
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "::error::Bad repository '$REPO'"; exit 1; }
[ -f "$SOURCE" ] || { echo "::error::No rendered file $SOURCE"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# The token goes in a header for this process only, never into a URL or .git/config.
auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
git -c http.extraheader="$auth" -c init.defaultBranch=main clone --quiet --depth 1 "https://github.com/$REPO.git" "$work/repo"

mkdir -p "$(dirname "$work/repo/$TARGET")"
cp "$SOURCE" "$work/repo/$TARGET"
cd "$work/repo"
git add -- "$TARGET"
if git diff --cached --quiet; then
  echo "$REPO: $TARGET is already up to date"
  exit 0
fi
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "sextant ${TAG#v}"
git -c http.extraheader="$auth" push --quiet origin HEAD
echo "$REPO: $TARGET updated to ${TAG#v}"
