#!/bin/bash
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
HM_HOME="${HIVEMIND_HOME:-$HOME/.hivemind}"
RT="$HM_HOME/runtime"

finish() {
  echo
  if [ -z "$HIVEMIND_NO_PAUSE" ]; then read -r -p "Press Enter to close this window. "; fi
  exit "${1:-0}"
}

echo
echo " Hivemind Setup"
echo " =============="
echo

# A downloaded app is quarantined by macOS; clear it on this folder so the bundled Node can run.
xattr -dr com.apple.quarantine "$HERE" 2>/dev/null

# Hooks are registered with the path of the Node that runs setup. Copy the right Node to a permanent place first,
# so they keep working after this folder is moved or deleted.
case "$(uname -m)" in
  arm64) NODE_SRC="$HERE/node/node-arm64" ;;
  *) NODE_SRC="$HERE/node/node-x64" ;;
esac
mkdir -p "$RT" && cp "$NODE_SRC" "$RT/node" && chmod 755 "$RT/node" || { echo "Could not copy Node to $RT"; finish 1; }
xattr -dr com.apple.quarantine "$RT" 2>/dev/null

PROJECT="$HIVEMIND_PROJECT"
if [ -z "$PROJECT" ]; then
  echo "Which project is this for? Drag the project folder onto this window, then press Enter."
  read -r -p "Project folder: " PROJECT
  # A dragged folder arrives with backslash-escaped characters and a trailing space.
  PROJECT="$(printf '%s' "$PROJECT" | sed -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//" -e 's/\\(.\)/\1/g')"
fi
[ -n "$PROJECT" ] || { echo "No folder given."; finish 1; }
cd "$PROJECT" 2>/dev/null || { echo "Could not open the folder \"$PROJECT\"."; finish 1; }

echo
"$RT/node" "$HERE/app/cli/hivemind.mjs" join "$@" || {
  echo
  echo "Setup did not finish. Read the message above, fix it, and run this again."
  finish 1
}

echo
"$RT/node" "$HERE/app/cli/hivemind.mjs" doctor
finish $?
