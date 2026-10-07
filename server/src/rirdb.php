<?php
/**
 * The local table of IP blocks as the five registries (ARIN, RIPE NCC, APNIC,
 * LACNIC, AFRINIC) handed them out: who each block was delegated to, where and
 * when. No network per click. The log records it on every hit (ip_block),
 * next to the ASN that routes the IP (netdb.php).
 *
 * Why: the ASN says who CARRIES the traffic; the registry says who OWNS the
 * block. A residential ISP's clicks normally come from its own blocks; a block
 * owned by someone else — an IP-leasing broker's (netutils, IPXO, Hilco…),
 * often registered in another country — routed through that ISP is the
 * pattern of "ISP" / residential proxies. Informational only: no rule reads it.
 *
 * Source: each registry's delegated-extended file (public, updated daily):
 * one line per delegation, `registry|cc|type|start|value|date|status|holder`,
 * where `holder` is an opaque id that is the same on every block and AS number
 * of the same organization (it has no name). Rebuilt once a day, after a
 * response (rirdb_maybe_refresh, one process at a time), into cache/rirdb/:
 *
 *   v4.bin       20-byte records: start (4) · end (4) · holder (4) · date (4) · cc (2) · rir (1) · status (1)
 *   v6.bin       44-byte records: start (16) · end (16) · holder (4) · date (4) · cc (2) · rir (1) · status (1)
 *   asn.bin      15-byte records: first AS (4) · last AS (4) · holder (4) · cc (2) · rir (1)
 *   holders.bin  count (4) · index of [offset (4) · length (1)] · the ids
 *   meta.json    when it was built, how many records
 *
 * Big-endian and sorted, so a lookup is a binary search (range_find, netdb.php).
 * Only delegated space (allocated/assigned): reserved and available blocks are
 * left out. Without a usable table (missing, or older than RIRDB_MAX_AGE) the
 * lookups return null and the hit goes without ip_block.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const RIRDB_SOURCES = [
    'arin'    => 'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
    'ripencc' => 'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
    'apnic'   => 'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
    'lacnic'  => 'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
    'afrinic' => 'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
];
/** The registry's code in the files → its byte in the records → the name the hit shows. */
const RIRDB_RIRS = ['afrinic' => 1, 'apnic' => 2, 'arin' => 3, 'lacnic' => 4, 'ripencc' => 5];
const RIRDB_RIR_NAMES = [1 => 'afrinic', 2 => 'apnic', 3 => 'arin', 4 => 'lacnic', 5 => 'ripe'];
const RIRDB_STATUSES = ['allocated' => 1, 'assigned' => 2];
/** Rebuilt after a day; not trusted after a week. A failed rebuild waits an hour. */
const RIRDB_REFRESH_AGE = 86400;
const RIRDB_MAX_AGE = 7 * 86400;
const RIRDB_RETRY_AFTER = 3600;
const RIRDB_REC_V4 = 20;
const RIRDB_REC_V6 = 44;
const RIRDB_REC_ASN = 15;

function rirdb_dir(): string
{
    return cache_dir() . '/rirdb';
}

/**
 * The hit's ip_block: the registry's delegation that holds the IP and how its
 * owner relates to the owner of the AS that routes it. relation: "same" (the
 * ISP's own block), "other" (another owner, registered in the AS's country —
 * an ISP's other company, its upstream's space, a customer's own block, or a
 * lease), "foreign" (another owner, registered in another country — usually a
 * lease). null when there's no table, the IP is in no delegated block, or
 * relation is null when the AS is unknown.
 *
 * @return array{range: string, rir: string, cc: ?string, date: ?string, status: string, holder: ?string, asn_holder: ?string, asn_cc: ?string, relation: ?string}|null
 */
function ip_block(string $ip, ?int $asn): ?array
{
    $block = rirdb_block($ip);
    if ($block === null) {
        return null;
    }
    $as = $asn !== null && $asn > 0 ? rirdb_asn($asn) : null;
    $relation = null;
    if ($as !== null && $as['holder'] !== null && $block['holder'] !== null) {
        $relation = $as['holder'] === $block['holder'] ? 'same' : ($block['cc'] !== null && $as['cc'] !== null && $block['cc'] !== $as['cc'] ? 'foreign' : 'other');
    }
    return $block + ['asn_holder' => $as['holder'] ?? null, 'asn_cc' => $as['cc'] ?? null, 'relation' => $relation];
}

/**
 * The delegation that holds the IP: its range (a CIDR when it is one), registry,
 * country, date, status and owner id; null = no table, or in no delegated block.
 *
 * @return array{range: string, rir: string, cc: ?string, date: ?string, status: string, holder: ?string}|null
 */
function rirdb_block(string $ip): ?array
{
    if (rirdb_meta() === null) {
        return null;
    }
    $bin = @inet_pton($ip);
    if ($bin === false || ($bin = (string) $bin) === '') {
        return null;
    }
    $v4 = strlen($bin) === 4;
    $h = rirdb_handle($v4 ? 'v4.bin' : 'v6.bin');
    $rec = $h === null ? null : range_find($h, $v4 ? RIRDB_REC_V4 : RIRDB_REC_V6, $bin);
    if ($rec === null) {
        return null;
    }
    $len = $v4 ? 4 : 16;
    $start = substr($rec, 0, $len);
    $end = substr($rec, $len, $len);
    ['h' => $holder, 'd' => $date] = unpack('Nh/Nd', substr($rec, 2 * $len, 8));
    $cc = substr($rec, 2 * $len + 8, 2);
    $prefix = range_prefix($start, $end);
    return [
        'range'  => $prefix !== null ? inet_ntop($start) . '/' . $prefix : inet_ntop($start) . '-' . inet_ntop($end),
        'rir'    => RIRDB_RIR_NAMES[ord($rec[2 * $len + 10])] ?? '?',
        'cc'     => rirdb_cc($cc),
        'date'   => $date > 0 ? sprintf('%04d-%02d-%02d', intdiv($date, 10000), intdiv($date, 100) % 100, $date % 100) : null,
        'status' => array_search(ord($rec[2 * $len + 11]), RIRDB_STATUSES, true) ?: '?',
        'holder' => rirdb_holder($holder),
    ];
}

/** The AS number's delegation: its owner id, country and registry; null = no table or not delegated. @return array{holder: ?string, cc: ?string, rir: string}|null */
function rirdb_asn(int $asn): ?array
{
    if ($asn <= 0 || rirdb_meta() === null) {
        return null;
    }
    $h = rirdb_handle('asn.bin');
    $rec = $h === null ? null : range_find($h, RIRDB_REC_ASN, pack('N', $asn));
    if ($rec === null) {
        return null;
    }
    return [
        'holder' => rirdb_holder((int) unpack('N', substr($rec, 8, 4))[1]),
        'cc'     => rirdb_cc(substr($rec, 12, 2)),
        'rir'    => RIRDB_RIR_NAMES[ord($rec[14])] ?? '?',
    ];
}

/** An owner id by its number in holders.bin (0 = none). */
function rirdb_holder(int $i): ?string
{
    $h = rirdb_handle('holders.bin');
    if ($i <= 0 || $h === null || fseek($h, 0) !== 0) {
        return null;
    }
    $count = (int) unpack('N', (string) fread($h, 4))[1];
    if ($i >= $count) {
        return null;
    }
    fseek($h, 4 + $i * 5);
    ['o' => $offset, 'l' => $length] = unpack('No/Cl', (string) fread($h, 5));
    fseek($h, 4 + $count * 5 + $offset);
    $id = (string) fread($h, $length);
    return $id !== '' ? $id : null;
}

/** A country code as the files have it; "ZZ" (unknown) and blanks → null. */
function rirdb_cc(string $cc): ?string
{
    return preg_match('/^[A-Z]{2}$/', $cc) === 1 && $cc !== 'ZZ' ? $cc : null;
}

/** The prefix length when [start, end] is exactly one CIDR block (same-size packed addresses), else null. */
function range_prefix(string $start, string $end): ?int
{
    $len = 0;
    $host = false;
    for ($i = 0, $n = strlen($start); $i < $n; $i++) {
        $s = ord($start[$i]);
        $diff = $s ^ ord($end[$i]);
        for ($bit = 7; $bit >= 0; $bit--) {
            $d = ($diff >> $bit) & 1;
            if (!$host && $d === 0) {
                $len++;
                continue;
            }
            // Host bits: the start has them all 0, the end all 1.
            $host = true;
            if ($d === 0 || (($s >> $bit) & 1) === 1) {
                return null;
            }
        }
    }
    return $len;
}

/** The table's meta (null = no usable table: missing, broken or too old). Read once per request. */
function rirdb_meta(): ?array
{
    $state = &rirdb_state();
    if (array_key_exists('meta', $state)) {
        return $state['meta'];
    }
    $dir = rirdb_dir();
    $raw = @file_get_contents("$dir/meta.json");
    $m = is_string($raw) ? json_decode($raw, true) : null;
    $ok = is_array($m) && is_int($m['built_at'] ?? null) && time() - $m['built_at'] < RIRDB_MAX_AGE
        && is_file("$dir/v4.bin") && is_file("$dir/v6.bin") && is_file("$dir/asn.bin") && is_file("$dir/holders.bin");
    return $state['meta'] = $ok ? $m : null;
}

/** Forgets what this request read and closes the files (after a rebuild; the tests). */
function rirdb_reset(): void
{
    $state = &rirdb_state();
    foreach ($state['files'] ?? [] as $h) {
        if (is_resource($h)) {
            fclose($h);
        }
    }
    $state = [];
}

/** The request's meta and open files. */
function &rirdb_state(): array
{
    static $state = [];
    return $state;
}

/** @return resource|null */
function rirdb_handle(string $file)
{
    $state = &rirdb_state();
    if (!array_key_exists($file, $state['files'] ?? [])) {
        $h = @fopen(rirdb_dir() . '/' . $file, 'rb');
        $state['files'][$file] = $h === false ? null : $h;
    }
    return $state['files'][$file];
}

// ── Keeping it fresh ─────────────────────────────────────────────────────────

/**
 * After a response: rebuilds the table when it's a day old (or missing), in
 * one process at a time, and not again for an hour after a failure. Nobody
 * waits — the connection is already closed. The five files are ~45 MB of text.
 */
function rirdb_maybe_refresh(): void
{
    $dir = rirdb_dir();
    $meta = @json_decode((string) @file_get_contents("$dir/meta.json"), true);
    $builtAt = is_array($meta) && is_int($meta['built_at'] ?? null) ? $meta['built_at'] : 0;
    if (time() - $builtAt < RIRDB_REFRESH_AGE || time() - (int) @filemtime("$dir/attempt") < RIRDB_RETRY_AFTER || !cache_writable()) {
        return;
    }
    $lock = try_lock('rirdb-refresh');
    if ($lock === null) {
        return;
    }
    try {
        @mkdir($dir, 0750, true);
        @touch("$dir/attempt");
        @set_time_limit(600);
        $files = [];
        foreach (RIRDB_SOURCES as $rir => $url) {
            $files[$rir] = "$dir/src-$rir.txt";
            if (!netdb_download($url, $files[$rir])) {
                error_log("[dayone-pages] rirdb: download failed ($rir)");
                foreach ($files as $f) {
                    @unlink($f);
                }
                return;
            }
        }
        rirdb_reset();
        if (rirdb_build(array_values($files), $dir) === null) {
            error_log('[dayone-pages] rirdb: build failed');
        }
        foreach ($files as $f) {
            @unlink($f);
        }
    } finally {
        unlock($lock);
    }
}

/**
 * Builds the table from the registries' delegated-extended files into $dir
 * (each file replaced atomically; meta.json last). It sorts ~430k records in
 * memory: well under a second, ~55 MB at the peak. Overlapping blocks (rare:
 * a transfer listed by two registries) keep the first after sorting. Returns
 * the counts, or null when an input is missing or has no blocks (the old
 * table stays).
 *
 * @param list<string> $files
 * @return array{v4: int, v6: int, asn: int, holders: int, overlaps: int}|null
 */
function rirdb_build(array $files, string $dir): ?array
{
    if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
        return null;
    }
    $holders = ['' => 0];
    $recs = ['v4' => [], 'v6' => [], 'asn' => []];
    foreach ($files as $file) {
        $in = @fopen($file, 'rb');
        if ($in === false) {
            return null;
        }
        while (($line = fgets($in, 1024)) !== false) {
            $p = explode('|', rtrim($line, "\r\n"));
            // registry|cc|type|start|value|date|status|holder — the version and summary lines have fewer fields or a "*".
            if (count($p) < 7 || $p[3] === '*' || !isset(RIRDB_RIRS[$p[0]], RIRDB_STATUSES[$p[6]])) {
                continue;
            }
            $holder = $holders[$p[7] ?? ''] ??= count($holders);
            $cc = preg_match('/^[A-Z]{2}$/', $p[1]) === 1 ? $p[1] : "\0\0";
            $rir = chr(RIRDB_RIRS[$p[0]]);
            $date = ctype_digit($p[5]) && strlen($p[5]) === 8 ? (int) $p[5] : 0;
            $tail = pack('NN', $holder, $date) . $cc . $rir . chr(RIRDB_STATUSES[$p[6]]);
            if ($p[2] === 'ipv4') {
                $start = ip2long($p[3]);
                $count = ctype_digit($p[4]) ? (int) $p[4] : 0;
                if ($start === false || $count < 1 || $start + $count - 1 > 0xFFFFFFFF) {
                    continue;
                }
                $recs['v4'][] = pack('NN', $start, $start + $count - 1) . $tail;
            } elseif ($p[2] === 'ipv6') {
                $start = (string) @inet_pton($p[3]);
                $len = ctype_digit($p[4]) ? (int) $p[4] : -1;
                if (strlen($start) !== 16 || $len < 0 || $len > 128) {
                    continue;
                }
                $recs['v6'][] = $start . ipv6_prefix_end($start, $len) . $tail;
            } elseif ($p[2] === 'asn') {
                $first = ctype_digit($p[3]) ? (int) $p[3] : 0;
                $count = ctype_digit($p[4]) ? (int) $p[4] : 0;
                if ($first < 1 || $count < 1 || $first + $count - 1 > 0xFFFFFFFF) {
                    continue;
                }
                $recs['asn'][] = pack('NNN', $first, $first + $count - 1, $holder) . $cc . $rir;
            }
        }
        fclose($in);
    }
    if ($recs['v4'] === [] || $recs['v6'] === [] || $recs['asn'] === []) {
        return null;
    }

    $counts = ['overlaps' => 0];
    foreach (['v4' => 4, 'v6' => 16, 'asn' => 4] as $kind => $keyLen) {
        sort($recs[$kind], SORT_STRING);
        $out = @fopen("$dir/$kind.bin.tmp", 'wb');
        if ($out === false) {
            return null;
        }
        $prevEnd = null;
        $n = 0;
        $buf = '';
        foreach ($recs[$kind] as $rec) {
            if ($prevEnd !== null && strcmp(substr($rec, 0, $keyLen), $prevEnd) <= 0) {
                $counts['overlaps']++;
                continue;
            }
            $prevEnd = substr($rec, $keyLen, $keyLen);
            $buf .= $rec;
            $n++;
            if (strlen($buf) > 65536) {
                fwrite($out, $buf);
                $buf = '';
            }
        }
        fwrite($out, $buf);
        fclose($out);
        $counts[$kind] = $n;
        $recs[$kind] = [];
    }

    // The owner ids, by their number: index 0 is "none".
    $index = '';
    $blob = '';
    foreach (array_keys($holders) as $id) {
        $id = substr((string) $id, 0, 255);
        $index .= pack('NC', strlen($blob), strlen($id));
        $blob .= $id;
    }
    if (@file_put_contents("$dir/holders.bin.tmp", pack('N', count($holders)) . $index . $blob) === false) {
        return null;
    }
    foreach (['v4.bin', 'v6.bin', 'asn.bin', 'holders.bin'] as $f) {
        if (!@rename("$dir/$f.tmp", "$dir/$f")) {
            return null;
        }
    }
    $result = ['v4' => $counts['v4'], 'v6' => $counts['v6'], 'asn' => $counts['asn'], 'holders' => count($holders) - 1, 'overlaps' => $counts['overlaps']];
    @file_put_contents("$dir/meta.json.tmp", (string) json_encode(['built_at' => time(), 'source' => 'RIR delegated-extended (ARIN, RIPE NCC, APNIC, LACNIC, AFRINIC)'] + $result));
    @rename("$dir/meta.json.tmp", "$dir/meta.json");
    return $result;
}

/** The last address of an IPv6 prefix: the start with its host bits set. */
function ipv6_prefix_end(string $start, int $len): string
{
    $end = '';
    for ($i = 0; $i < 16; $i++) {
        $keep = max(0, min(8, $len - $i * 8));
        $end .= chr(ord($start[$i]) | (0xFF >> $keep));
    }
    return $end;
}
