#!/usr/bin/env bash
# Builds the "drop into the site folder" version: for hosting with a control
# panel (CloudPanel, Plesk...), where the site folder IS the webroot and you
# can't put src/ and .env outside it.
#
#   index.php      entry point (the only file nginx needs to call)
#   config.php     configuration (instead of .env; never delivered as text)
#   _dayone/       the code from src/, each file with a guard against direct access
#   _cache/        created automatically on the first visit
#
# The source is still server/src/ — this folder is GENERATED, not edited.
# Usage: bash server/build-dropin.sh [destination]     (default: server/dist/dropin)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/dist/dropin}"

rm -rf "$OUT" && mkdir -p "$OUT/_dayone"
cp "$HERE"/src/*.php "$OUT/_dayone/"
cp "$HERE/dropin/index.php" "$OUT/index.php"
cp "$HERE/dropin/config.php" "$OUT/config.php"

# Every internal file must carry the guard. Without it, a direct request runs the file.
for f in "$OUT"/_dayone/*.php "$OUT/config.php"; do
  grep -q "defined('DAYONE_ENTRY')" "$f" || { echo "NO GUARD: $f" >&2; exit 1; }
done
for f in "$OUT"/index.php "$OUT"/config.php "$OUT"/_dayone/*.php; do php -l "$f" >/dev/null; done

# What the folder was built from, for /_dop/version (handlers.php): the commit, the
# server files that differed from it, and the code's sha (a file changed by hand later shows).
REPO="$(cd "$HERE/.." && pwd)"
COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
UNCOMMITTED="$(git -C "$REPO" status --porcelain -- server/src server/dropin 2>/dev/null | cut -c4- | grep '\.php$' || true)"
php -r '
define("DAYONE_ENTRY", true);
require $argv[1] . "/handlers.php";
$version = [
    "commit" => $argv[2] !== "" ? $argv[2] : null,
    "branch" => $argv[3] !== "" ? $argv[3] : null,
    "uncommitted" => array_values(array_filter(explode("\n", $argv[4]), "strlen")),
    "built_at" => gmdate("c"),
    "code_sha" => code_sha($argv[1]),
];
file_put_contents($argv[1] . "/" . VERSION_FILE, json_encode($version, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
' "$OUT/_dayone" "$COMMIT" "$BRANCH" "$UNCOMMITTED"

echo "drop-in built at $OUT ($(cut -c1-12 <<<"$COMMIT")${UNCOMMITTED:+, with uncommitted changes})"
