<?php
/**
 * Dev-only: regenerates the EVAL_SCRIPT constant in ../src/eval.php from the
 * generator (eval_checkpoint_build). Run after changing the checkpoint's
 * signals, and review the diff:
 *
 *   php server/dev/regen-eval-script.php
 *
 * The constant is the script the checkpoint serves — a fixed, obfuscated
 * blob (zero work per response). Never edit it by hand.
 */
declare(strict_types=1);

define('DAYONE_ENTRY', true);
putenv('CACHE_DIR=' . sys_get_temp_dir() . '/dop-regen-' . getmypid());

require __DIR__ . '/../src/bootstrap.php';

$file = __DIR__ . '/../src/eval.php';
$src = file_get_contents($file);
if ($src === false) {
    fwrite(STDERR, "cannot read $file\n");
    exit(1);
}

$script = eval_checkpoint_build();

// The constant's value is a var_export single-quoted literal, wrapped to keep
// the source readable: "const EVAL_SCRIPT =\n    '<blob>';\n".
$block = "const EVAL_SCRIPT =\n    " . var_export($script, true) . ";";

// The blob is a single-quoted var_export literal spanning lines (its \n are
// literal), ending in "})();';" — match up to that marker, /s for the newlines.
// A callback returns the block verbatim (no $/\ interpretation in the replacement).
$replaced = preg_replace_callback("/const EVAL_SCRIPT =\n    '.+?\\)\\(\\);';/s", static fn () => $block, $src, 1, $n);
if ($n === 0) {
    // First time: no constant yet — insert before the generator's docblock.
    $marker = "/**\n * Builds the checkpoint's script, OBFUSCATED.";
    if (!str_contains($src, $marker)) {
        fwrite(STDERR, "EVAL_SCRIPT constant not found and no insertion marker in $file\n");
        exit(1);
    }
    $replaced = preg_replace('/' . preg_quote($marker, '/') . '/', $block . "\n\n" . $marker, $src, 1, $n);
}
if ($replaced === null || $n === 0) {
    fwrite(STDERR, "failed to place EVAL_SCRIPT in $file\n");
    exit(1);
}
file_put_contents($file, $replaced);
echo "EVAL_SCRIPT regenerated (" . strlen($script) . " bytes of JS) in src/eval.php\n";
