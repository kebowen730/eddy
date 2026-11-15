#!/usr/bin/env bash
# Release a version of Eddy and keep it playable at its own URL.
#
#   scripts/release.sh v2              tag HEAD as v2, publish a GitHub release, deploy it to
#                                      https://eddy-ink-v2.fly.dev/ and to the latest site
#   scripts/release.sh v1 --no-latest  (re)deploy an existing tag to its own URL only
#
# Each version gets its own Fly app (eddy-ink-<version>), built from exactly the tagged
# commit. The main app (eddy-ink) always shows the newest release.
set -euo pipefail

LATEST_APP="eddy-ink"
ORG="personal"

tag="${1:-}"
update_latest=1
[[ "${2:-}" == "--no-latest" ]] && update_latest=0

if [[ ! "$tag" =~ ^v[0-9]+(\.[0-9]+)*$ ]]; then
  echo "usage: scripts/release.sh <version> [--no-latest]   e.g. v2 or v1.1" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"
app="${LATEST_APP}-${tag//./-}"
url="https://${app}.fly.dev/"

# --- tag ---------------------------------------------------------------------
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "==> Tag $tag already exists; deploying that commit."
else
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree has uncommitted changes. Commit them before releasing." >&2
    exit 1
  fi
  echo "==> Tagging HEAD as $tag"
  git push -q origin HEAD
  git tag -a "$tag" -m "Eddy $tag"
  git push -q origin "$tag"
fi

# --- GitHub release ----------------------------------------------------------
if gh release view "$tag" >/dev/null 2>&1; then
  echo "==> GitHub release $tag already exists."
else
  echo "==> Publishing GitHub release $tag"
  gh release create "$tag" --verify-tag --title "$tag" \
    --notes "Play this version: $url" --generate-notes
fi

# --- build from exactly the tagged commit ------------------------------------
src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT
git archive "$tag" | tar -x -C "$src"

deploy() {
  local name="$1"
  if ! flyctl status --app "$name" >/dev/null 2>&1; then
    echo "==> Creating Fly app $name"
    flyctl apps create "$name" --org "$ORG"
  fi
  echo "==> Deploying $tag to $name"
  (cd "$src" && flyctl deploy --app "$name" --ha=false)
  # First deploys do not always get public addresses; make sure they exist.
  # Capture the list first: piping straight into `grep -q` under pipefail reports failure when
  # grep exits early, which would allocate a second set of addresses for an app that has them.
  local ips
  if ips="$(flyctl ips list --app "$name" 2>/dev/null)" && ! grep -qE '^v[46]' <<<"$ips"; then
    echo "==> Allocating public IPs for $name"
    flyctl ips allocate-v4 --shared --app "$name"
    flyctl ips allocate-v6 --app "$name"
  fi
}

deploy "$app"
[[ $update_latest -eq 1 ]] && deploy "$LATEST_APP"

echo
echo "Done."
echo "  $tag:    $url"
[[ $update_latest -eq 1 ]] && echo "  latest: https://${LATEST_APP}.fly.dev/"
exit 0
