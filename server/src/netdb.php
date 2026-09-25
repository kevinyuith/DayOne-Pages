<?php
/**
 * The local IP → ASN / country table: no network per click. The rules' ASN
 * condition, the log's ASN/AS name and the country fallback read it.
 *
 * Source: iptoasn.com (public domain, PDDL v1.0), ip2asn-v4-u32.tsv.gz and
 * ip2asn-v6.tsv.gz: sorted, non-overlapping ranges with the AS number, the
 * AS's country and its description. Rebuilt once a day, after a response
 * (netdb_maybe_refresh, one process at a time), into cache/netdb/:
 *
 *   v4.bin     14-byte records: start (4) · end (4) · asn (4) · country (2)
 *   v6.bin     38-byte records: start (16) · end (16) · asn (4) · country (2)
 *   names.bin  count (4) · index of [asn (4) · offset (4) · length (2)] · names
 *   meta.json  when it was built, from what, how many ranges
 *
 * Addresses are big-endian, so the records sort as strings and a lookup is a
 * binary search (≈20 reads of a file the OS keeps in memory). Not-routed
 * ranges (AS 0) are left out: an IP in none of the ranges has no ASN.
 *
 * Without a usable table (never built, or older than NETDB_MAX_AGE) the
 * lookups return null and netinfo.php falls back to Team Cymru over DNS.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const NETDB_SOURCE_V4 = 'https://iptoasn.com/data/ip2asn-v4-u32.tsv.gz';
const NETDB_SOURCE_V6 = 'https://iptoasn.com/data/ip2asn-v6.tsv.gz';
/** Rebuilt after a day; not trusted after a week (the DNS fallback takes over). */
const NETDB_REFRESH_AGE = 86400;
const NETDB_MAX_AGE = 7 * 86400;
/** A failed rebuild isn't tried again for an hour. */
const NETDB_RETRY_AFTER = 3600;
const NETDB_REC_V4 = 14;
const NETDB_REC_V6 = 38;

function netdb_dir(): string
{
    return cache_dir() . '/netdb';
}

/** The table's meta (null = no usable table: missing, broken or too old). Read once per request. */
function netdb_meta(): ?array
{
    $state = &netdb_state();
    if (array_key_exists('meta', $state)) {
        return $state['meta'];
    }
    $raw = @file_get_contents(netdb_dir() . '/meta.json');
    $m = is_string($raw) ? json_decode($raw, true) : null;
    $ok = is_array($m) && is_int($m['built_at'] ?? null) && time() - $m['built_at'] < NETDB_MAX_AGE
        && is_file(netdb_dir() . '/v4.bin') && is_file(netdb_dir() . '/v6.bin') && is_file(netdb_dir() . '/names.bin');
    return $state['meta'] = $ok ? $m : null;
}

/** Forgets what this request read and closes the files (after a rebuild; the tests). */
function netdb_reset(): void
{
    $state = &netdb_state();
    foreach ($state['files'] ?? [] as $h) {
        if (is_resource($h)) {
            fclose($h);
        }
    }
    $state = [];
}

/** The request's meta and open files. */
function &netdb_state(): array
{
    static $state = [];
    return $state;
}

/**
 * The IP's AS number and country from the table: ['asn' => n, 'cc' => 'US'|null];
 * asn 0 = in no routed range (or a private IP). null = no usable table (fall back).
 */
function netdb_lookup(string $ip): ?array
{
    if (netdb_meta() === null) {
        return null;
    }
    $bin = @inet_pton($ip);
    if ($bin === false || $bin === '') {
        return ['asn' => 0, 'cc' => null];
    }
    $v4 = strlen($bin) === 4;
    $rec = netdb_find($v4 ? 'v4.bin' : 'v6.bin', $v4 ? NETDB_REC_V4 : NETDB_REC_V6, $bin);
    if ($rec === null) {
        return ['asn' => 0, 'cc' => null];
    }
    $at = $v4 ? 8 : 32;
    $cc = substr($rec, $at + 4, 2);
    return ['asn' => (int) unpack('N', substr($rec, $at, 4))[1], 'cc' => $cc === "\0\0" ? null : $cc];
}

/** The name of an AS from the table (null = unknown or no table). */
function netdb_as_name(int $asn): ?string
{
    if ($asn <= 0 || netdb_meta() === null) {
        return null;
    }
    $h = netdb_handle('names.bin');
    if ($h === null || fseek($h, 0) !== 0) {
        return null;
    }
    $count = (int) unpack('N', (string) fread($h, 4))[1];
    $want = pack('N', $asn);
    $lo = 0;
    $hi = $count - 1;
    while ($lo <= $hi) {
        $mid = ($lo + $hi) >> 1;
        fseek($h, 4 + $mid * 10);
        $entry = (string) fread($h, 10);
        $cmp = strcmp(substr($entry, 0, 4), $want);
        if ($cmp === 0) {
            ['o' => $offset, 'l' => $length] = unpack('No/nl', substr($entry, 4));
            fseek($h, 4 + $count * 10 + $offset);
            $name = (string) fread($h, $length);
            return $name !== '' ? $name : null;
        }
        if ($cmp < 0) {
            $lo = $mid + 1;
        } else {
            $hi = $mid - 1;
        }
    }
    return null;
}

/** The record whose range holds the packed address (binary search on the starts), or null. */
function netdb_find(string $file, int $recLen, string $bin): ?string
{
    $h = netdb_handle($file);
    if ($h === null) {
        return null;
    }
    $n = intdiv((int) (fstat($h)['size'] ?? 0), $recLen);
    $keyLen = strlen($bin);
    $lo = 0;
    $hi = $n - 1;
    $found = null;
    while ($lo <= $hi) {
        $mid = ($lo + $hi) >> 1;
        fseek($h, $mid * $recLen);
        $rec = (string) fread($h, $recLen);
        if (strcmp(substr($rec, 0, $keyLen), $bin) <= 0) {
            $found = $rec;
            $lo = $mid + 1;
        } else {
            $hi = $mid - 1;
        }
    }
    return $found !== null && strcmp($bin, substr($found, $keyLen, $keyLen)) <= 0 ? $found : null;
}

/** @return resource|null */
function netdb_handle(string $file)
{
    $state = &netdb_state();
    if (!array_key_exists($file, $state['files'] ?? [])) {
        $h = @fopen(netdb_dir() . '/' . $file, 'rb');
        $state['files'][$file] = $h === false ? null : $h;
    }
    return $state['files'][$file];
}

// ── Keeping it fresh ─────────────────────────────────────────────────────────

/**
 * After a response: rebuilds the table when it's a day old (or missing), in
 * one process at a time, and not again for an hour after a failure. Nobody
 * waits — the connection is already closed.
 */
function netdb_maybe_refresh(): void
{
    $dir = netdb_dir();
    $meta = @json_decode((string) @file_get_contents("$dir/meta.json"), true);
    $builtAt = is_array($meta) && is_int($meta['built_at'] ?? null) ? $meta['built_at'] : 0;
    if (time() - $builtAt < NETDB_REFRESH_AGE || time() - (int) @filemtime("$dir/attempt") < NETDB_RETRY_AFTER || !cache_writable()) {
        return;
    }
    $lock = try_lock('netdb-refresh');
    if ($lock === null) {
        return;
    }
    try {
        @mkdir($dir, 0750, true);
        @touch("$dir/attempt");
        @set_time_limit(300);
        $v4 = "$dir/src-v4.tsv.gz";
        $v6 = "$dir/src-v6.tsv.gz";
        if (!netdb_download(NETDB_SOURCE_V4, $v4) || !netdb_download(NETDB_SOURCE_V6, $v6)) {
            error_log('[dayone-pages] netdb: download failed');
            return;
        }
        netdb_reset();
        if (netdb_build($v4, $v6, $dir) === null) {
            error_log('[dayone-pages] netdb: build failed');
        }
        @unlink($v4);
        @unlink($v6);
    } finally {
        unlock($lock);
    }
}

function netdb_download(string $url, string $to): bool
{
    $fh = @fopen("$to.part", 'wb');
    if ($fh === false) {
        return false;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FILE => $fh,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 180,
        CURLOPT_USERAGENT => 'dayone-pages/netdb',
        CURLOPT_FAILONERROR => true,
    ]);
    $ok = curl_exec($ch) !== false && (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 200;
    fclose($fh);
    if (!$ok || (int) @filesize("$to.part") < 1000) {
        @unlink("$to.part");
        return false;
    }
    return @rename("$to.part", $to);
}

/**
 * Builds the table from the two iptoasn files into $dir (each file replaced
 * atomically; meta.json last). Streams the input: no whole file in memory.
 * Returns the counts, or null if an input is broken (the old table stays).
 *
 * @return array{v4: int, v6: int, names: int}|null
 */
function netdb_build(string $v4Gz, string $v6Gz, string $dir): ?array
{
    if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
        return null;
    }
    $names = [];
    $counts = ['v4' => 0, 'v6' => 0];
    foreach (['v4' => $v4Gz, 'v6' => $v6Gz] as $family => $src) {
        $in = @gzopen($src, 'rb');
        $out = @fopen("$dir/$family.bin.tmp", 'wb');
        if ($in === false || $out === false) {
            return null;
        }
        $prevEnd = '';
        $buf = '';
        while (($line = gzgets($in, 4096)) !== false) {
            $p = explode("\t", rtrim($line, "\r\n"), 5);
            if (count($p) < 4 || $p[2] === '0') {
                continue; // not routed
            }
            if ($family === 'v4') {
                if (!ctype_digit($p[0]) || !ctype_digit($p[1])) {
                    continue;
                }
                $start = pack('N', (int) $p[0]);
                $end = pack('N', (int) $p[1]);
            } else {
                $start = (string) @inet_pton($p[0]);
                $end = (string) @inet_pton($p[1]);
                if (strlen($start) !== 16 || strlen($end) !== 16) {
                    continue;
                }
            }
            if (strcmp($start, $prevEnd) <= 0 && $prevEnd !== '') {
                // Not sorted/overlapping: this input can't be binary-searched. Keep the old table.
                gzclose($in);
                fclose($out);
                @unlink("$dir/$family.bin.tmp");
                return null;
            }
            $prevEnd = $end;
            $asn = (int) $p[2];
            $cc = preg_match('/^[A-Z]{2}$/', $p[3]) === 1 ? $p[3] : "\0\0";
            $buf .= $start . $end . pack('N', $asn) . $cc;
            if (strlen($buf) > 65536) {
                fwrite($out, $buf);
                $buf = '';
            }
            $counts[$family]++;
            if (!isset($names[$asn])) {
                $names[$asn] = substr(trim($p[4] ?? ''), 0, 250);
            }
        }
        fwrite($out, $buf);
        gzclose($in);
        fclose($out);
        if ($counts[$family] === 0) {
            @unlink("$dir/$family.bin.tmp");
            return null;
        }
    }

    ksort($names, SORT_NUMERIC);
    $index = '';
    $blob = '';
    foreach ($names as $asn => $name) {
        $index .= pack('NNn', $asn, strlen($blob), strlen($name));
        $blob .= $name;
    }
    if (@file_put_contents("$dir/names.bin.tmp", pack('N', count($names)) . $index . $blob) === false) {
        return null;
    }
    foreach (['v4.bin', 'v6.bin', 'names.bin'] as $f) {
        if (!@rename("$dir/$f.tmp", "$dir/$f")) {
            return null;
        }
    }
    $result = $counts + ['names' => count($names)];
    @file_put_contents("$dir/meta.json.tmp", (string) json_encode(['built_at' => time(), 'source' => 'iptoasn.com (PDDL)'] + $result));
    @rename("$dir/meta.json.tmp", "$dir/meta.json");
    return $result;
}
