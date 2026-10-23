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

case "$HERE" in
  /Volumes/*|/private/var/folders/*|*/AppTranslocation/*)
    echo "This looks like it is running from a disk image or a temporary copy."
    echo "Drag the Hivemind folder to your Documents folder (or Desktop), then open it from there."
    finish 1 ;;
esac

# A downloaded app is quarantined by macOS; clear it on this folder so the bundled Node can run.
xattr -dr com.apple.quarantine "$HERE" 2>/dev/null

# Hooks are registered with the path of the Node that runs setup. Copy the right Node to a permanent place first,
# so they keep working after this folder is moved or deleted. Copy to a new file and rename it over the old one: a
# binary that already ran must not be overwritten in place.
case "$(uname -m)" in
  arm64) NODE_SRC="$HERE/node/node-arm64" ;;
  *) NODE_SRC="$HERE/node/node-x64" ;;
esac
[ -f "$NODE_SRC" ] || { echo "The bundled Node is missing. Unzip the whole download again."; finish 1; }
mkdir -p "$RT" || { echo "Could not create $RT"; finish 1; }
if ! cmp -s "$NODE_SRC" "$RT/node"; then
  cp "$NODE_SRC" "$RT/node.new" && chmod 755 "$RT/node.new" && mv -f "$RT/node.new" "$RT/node" \
    || { echo "Could not copy Node to $RT"; rm -f "$RT/node.new"; finish 1; }
fi
xattr -dr com.apple.quarantine "$RT" 2>/dev/null

PROJECT="$HIVEMIND_PROJECT"
if [ -z "$PROJECT" ]; then
  echo "Which project is this for? Drag the project folder onto this window, then press Enter."
  read -r -p "Project folder: " PROJECT
  # A dragged folder arrives with backslash-escaped characters, maybe quotes, and a trailing space.
  PROJECT="$("$RT/node" -e '
    let s = process.argv[1] || "";
    s = s.replace(/\s+$/, "").replace(/^["\x27]|["\x27]$/g, "").replace(/\x5c(.)/g, "$1");
    if (s === "~" || s.startsWith("~/")) s = process.env.HOME + s.slice(1);
    process.stdout.write(s);
  ' "$PROJECT")"
fi
[ -n "$PROJECT" ] || { echo "No folder given."; finish 1; }
cd "$PROJECT" 2>/dev/null || { echo "Could not open that folder."; finish 1; }

echo
"$RT/node" "$HERE/app/cli/hivemind.mjs" join "$@" || {
  echo
  echo "Setup did not finish. Read the message above, fix it, and run this again."
  finish 1
}

echo
"$RT/node" "$HERE/app/cli/hivemind.mjs" doctor
finish $?
