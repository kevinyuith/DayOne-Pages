<?php
/**
 * Known anonymizers, for the log: is the click behind a VPN, Tor, a proxy on
 * leased "ISP" space, Apple's iCloud Private Relay or a hosting network — and
 * whose. A local table, no network per click. INFORMATIONAL ONLY: no rule
 * reads it (VPN users buy — more than average, measured 07/10).
 *
 * What is_vpn means: a commercial VPN, a Tor exit or an "ISP proxy" (a block
 * of a known IP-leasing company routed through a residential ISP). iCloud
 * Private Relay (normal iPhones with the privacy option on) and hosting
 * networks are marked with their kind and name but are NOT is_vpn.
 *
 * Sources, rebuilt once a day after a response (anondb_maybe_refresh, one
 * process at a time) into cache/anondb/ — each kind is a sorted list of
 * merged ranges (`<kind>-v4.bin` 8-byte and `<kind>-v6.bin` 32-byte records:
 * start · end), looked up with range_find (netdb.php):
 *
 *   tor      check.torproject.org's exit list (the Tor Project)
 *   relay    Apple's iCloud Private Relay egress ranges (published by Apple)
 *   vpn      X4BNet lists_vpn "vpn" (MIT): the ranges of VPN providers' networks
 *   hosting  X4BNet lists_vpn "datacenter" (MIT): clouds and hosting
 *
 * plus two lists kept here: AS numbers that only carry a VPN (with the name
 * to show), and the owner ids (rirdb.php) of IP-leasing companies seen behind
 * residential ISPs (the 07/10 analysis). A VPN's own servers can't be listed
 * by IP: their exits aren't the IPs the providers publish — the network is
 * what gives them away.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const ANONDB_SOURCES = [
    'tor'     => 'https://check.torproject.org/torbulkexitlist',
    'relay'   => 'https://mask-api.icloud.com/egress-ip-ranges.csv',
    'vpn'     => 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt',
    'hosting' => 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt',
];
/** The hit's vpn_kind values. */
const ANON_KINDS = ['vpn', 'tor', 'isp_proxy', 'relay', 'hosting'];
/** AS numbers whose traffic is a VPN's (by the AS's own name), and the name to show. */
const ANON_VPN_ASNS = [
    136787 => 'PacketHub (NordVPN)',
    141039 => 'PacketHub (NordVPN)',
    147049 => 'PacketHub (NordVPN)',
    207137 => 'PacketHub (NordVPN)',
    272096 => 'PacketHub (NordVPN)',
    209854 => 'Cyberzone',
    62371  => 'Proton VPN',
    199218 => 'Proton VPN',
    209103 => 'Proton VPN',
    13926  => 'NetProtect',
    54203  => 'NetProtect',
    62651  => 'NetProtect',
    197640 => 'NetProtect',
    216025 => 'Mullvad',
    203619 => 'IVPN',
    397540 => 'Windscribe',
    62579  => 'VirtualShield',
    206092 => 'Firewalla',
];
/**
 * Registry owner ids (rirdb.php's holder) of IP-leasing companies — or of
 * blocks they lease out — seen routed through US residential ISPs (Cox, RCN,
 * Windstream, Frontier…), with the name to show. Only counts when the block
 * isn't the routing AS's own (ip_block relation other/foreign).
 */
const ANON_LEASE_HOLDERS = [
    'dab045bb7a397aa6d925eb7382eabde5' => '20 Point Networks',
    '3fafaa5b65f3ebb6914b124b78358eef' => 'Atlas Networks',
    'ef539ae1-d126-4f1e-9156-8c8432cff858' => 'Aventice',
    '0fb7e053-0e5a-4fce-8879-1b42bcf7e6ce' => 'Aviation RE',
    '62ed8e55b98b8fba03248ff785bb67a9' => 'Blazing SEO',
    'F368F2D0' => 'Cloud Innovation',
    '092f63559b234cca563e5978c85964c9' => 'CodeLuxe',
    '785a21b4192bb31d560b7eaead6ce057' => 'Flux Telecom',
    'f27cb3238fd51ec9a0b5163cb56094ed' => 'Flux Telecom',
    'bf677452-3fc2-4602-86d7-ec4584b220db' => 'Hilco/Glide',
    'A91510AD' => 'IP lease (Accesstel BD)',
    'ab2e32f14feb4bdb5eff7f601c237178' => 'IP lease (Private Customer)',
    '49c314bb2f6f173d969d74cc6080d866' => 'IP lease (Private Customer)',
    '59f1e307-15c1-4fe6-8d1a-62855e22a6ca' => 'IP lease (Segna RO)',
    'A912FC73' => 'IP lease (Telenet NC)',
    'cb8139aa-989a-4280-9b63-b089999be339' => 'IP lease (URAN UA)',
    'f9aac01a-f964-49a9-9d82-4b27ed1427c6' => 'IP lease (WGIX GE)',
    'ee5fcda0-f7e2-48b6-b989-72c32d3e8f67' => 'IPXO',
    'ea7310aa-5581-40c0-9f55-fffa7b96d3e6' => 'IPXO',
    '27e5754f-55ea-48c7-8940-2f2f801996a0' => 'IPXO',
    '84c4d47c-8cd6-44ef-88de-afccc4fde5a9' => 'IPXO',
    '5eda7020-cc8b-4a11-92bd-fda838fc809e' => 'IP_Net_Mobility',
    '0b41d234-5b82-4fd6-9ae8-f0cb6939c48a' => 'InterLIR',
    'ede61704-a0cd-4e27-904a-6f86b026557d' => 'Internet Utilities',
    'acff74e5-03e7-4f1f-b78d-e51a3df0067e' => 'Internet Utilities',
    'F36C58D6' => 'Internet Utilities',
    'd777ac83191162d85449347acc323c31' => 'JETFLY',
    '70c2785b033e4f890081eb284e2c5c8a' => 'Outlet Season Group',
    'f7a953854b62a8dda3934b7136008918' => 'Plexintnet',
    '3b93f1ce0384793668b3c7675de2432f' => 'Syban Systems',
    '9fbe5214-ecf9-421d-8124-ca745444d231' => 'code200',
    '6874477a-e2b4-4970-a0be-29473b562790' => 'netutils',
    '1dc61fac-1602-427a-a8f6-4accb624e742' => 'netutils',
    'b850adcb-3ca0-4ef4-903e-828154b6e43e' => 'netutils',
    'c41c1074-c724-4139-9250-cb6d11158cad' => 'netutils',
    '0d6f8c1a-44c4-4d5c-895e-a9669cf54469' => 'netutils',
    '50064da2-ca5e-418a-8e88-0b29eacc4994' => 'netutils',
    '97ba3447-c40a-4ee3-8646-f5654c22e498' => 'netutils',
    'f443403e-855e-4643-a9d0-752ce10a33ab' => 'netutils',
    '1650bd99-ffce-45f5-9ecb-b6c7716ce8e3' => 'netutils',
    '3ded8b18-d662-462b-a408-f125eb27bea2' => 'wookra',
];
/** Rebuilt after a day; not trusted after a week. A failed rebuild waits an hour. */
const ANONDB_REFRESH_AGE = 86400;
const ANONDB_MAX_AGE = 7 * 86400;
const ANONDB_RETRY_AFTER = 3600;

function anondb_dir(): string
{
    return cache_dir() . '/anondb';
}

/**
 * The hit's VPN fields: is_vpn, kind (ANON_KINDS) and the name to show
 * (a VPN's or a leasing company's; for the lists, the AS's name). null = no
 * table (unknown); a click that is none of them gets is_vpn false, no kind.
 *
 * @param array{relation: ?string, holder: ?string}|null $block the hit's ip_block (rirdb.php)
 * @return array{is_vpn: bool, kind: ?string, name: ?string}|null
 */
function anon_classify(string $ip, ?int $asn, ?array $block): ?array
{
    if (anondb_meta() === null) {
        return null;
    }
    $bin = @inet_pton($ip);
    $bin = $bin === false ? '' : (string) $bin;
    $none = ['is_vpn' => false, 'kind' => null, 'name' => null];
    if ($bin === '') {
        return $none;
    }
    $asn = $asn !== null && $asn > 0 ? $asn : null;
    if (anondb_in('tor', $bin)) {
        return ['is_vpn' => true, 'kind' => 'tor', 'name' => 'Tor'];
    }
    // Before the VPN list: Apple's relays run on Cloudflare/Akamai/Fastly, which a VPN list may also carry.
    if (anondb_in('relay', $bin)) {
        return ['is_vpn' => false, 'kind' => 'relay', 'name' => 'iCloud Private Relay'];
    }
    if ($asn !== null && isset(ANON_VPN_ASNS[$asn])) {
        return ['is_vpn' => true, 'kind' => 'vpn', 'name' => ANON_VPN_ASNS[$asn]];
    }
    if (anondb_in('vpn', $bin)) {
        return ['is_vpn' => true, 'kind' => 'vpn', 'name' => anon_as_label($asn)];
    }
    // After the VPN checks: a VPN on leased space is a VPN; a residential ISP routing a leasing company's block is the proxy.
    $holder = $block['holder'] ?? null;
    if (in_array($block['relation'] ?? null, ['other', 'foreign'], true) && is_string($holder) && isset(ANON_LEASE_HOLDERS[$holder])) {
        return ['is_vpn' => true, 'kind' => 'isp_proxy', 'name' => ANON_LEASE_HOLDERS[$holder]];
    }
    if (anondb_in('hosting', $bin)) {
        return ['is_vpn' => false, 'kind' => 'hosting', 'name' => anon_as_label($asn)];
    }
    return $none;
}

/** The name of the AS that routes the IP (netdb), for a list's match. */
function anon_as_label(?int $asn): ?string
{
    if ($asn === null) {
        return null;
    }
    return netdb_as_name($asn) ?? "AS$asn";
}

/** Is the packed address in one of the kind's ranges? */
function anondb_in(string $kind, string $bin): bool
{
    $v4 = strlen($bin) === 4;
    $h = anondb_handle($kind . ($v4 ? '-v4.bin' : '-v6.bin'));
    return $h !== null && range_find($h, $v4 ? 8 : 32, $bin) !== null;
}

/** The table's meta (null = no usable table: missing, broken or too old). Read once per request. */
function anondb_meta(): ?array
{
    $state = &anondb_state();
    if (array_key_exists('meta', $state)) {
        return $state['meta'];
    }
    $dir = anondb_dir();
    $raw = @file_get_contents("$dir/meta.json");
    $m = is_string($raw) ? json_decode($raw, true) : null;
    $ok = is_array($m) && is_int($m['built_at'] ?? null) && time() - $m['built_at'] < ANONDB_MAX_AGE;
    foreach (array_keys(ANONDB_SOURCES) as $kind) {
        $ok = $ok && is_file("$dir/$kind-v4.bin") && is_file("$dir/$kind-v6.bin");
    }
    return $state['meta'] = $ok ? $m : null;
}

/** Forgets what this request read and closes the files (after a rebuild; the tests). */
function anondb_reset(): void
{
    $state = &anondb_state();
    foreach ($state['files'] ?? [] as $h) {
        if (is_resource($h)) {
            fclose($h);
        }
    }
    $state = [];
}

/** The request's meta and open files. */
function &anondb_state(): array
{
    static $state = [];
    return $state;
}

/** @return resource|null */
function anondb_handle(string $file)
{
    $state = &anondb_state();
    if (!array_key_exists($file, $state['files'] ?? [])) {
        $h = @fopen(anondb_dir() . '/' . $file, 'rb');
        $state['files'][$file] = $h === false ? null : $h;
    }
    return $state['files'][$file];
}

// ── Keeping it fresh ─────────────────────────────────────────────────────────

/**
 * After a response: rebuilds the table when it's a day old (or missing), in
 * one process at a time, and not again for an hour after a failure. Nobody
 * waits — the connection is already closed. All four sources or none: a
 * failed download keeps the old table.
 */
function anondb_maybe_refresh(): void
{
    $dir = anondb_dir();
    $meta = @json_decode((string) @file_get_contents("$dir/meta.json"), true);
    $builtAt = is_array($meta) && is_int($meta['built_at'] ?? null) ? $meta['built_at'] : 0;
    if (time() - $builtAt < ANONDB_REFRESH_AGE || time() - (int) @filemtime("$dir/attempt") < ANONDB_RETRY_AFTER || !cache_writable()) {
        return;
    }
    $lock = try_lock('anondb-refresh');
    if ($lock === null) {
        return;
    }
    try {
        @mkdir($dir, 0750, true);
        @touch("$dir/attempt");
        @set_time_limit(600);
        $files = [];
        foreach (ANONDB_SOURCES as $kind => $url) {
            $files[$kind] = "$dir/src-$kind.txt";
            if (!netdb_download($url, $files[$kind])) {
                error_log("[dayone-pages] anondb: download failed ($kind)");
                foreach ($files as $f) {
                    @unlink($f);
                }
                return;
            }
        }
        anondb_reset();
        if (anondb_build($files, $dir) === null) {
            error_log('[dayone-pages] anondb: build failed');
        }
        foreach ($files as $f) {
            @unlink($f);
        }
    } finally {
        unlock($lock);
    }
}

/**
 * Builds each kind's ranges from its source into $dir (each file replaced
 * atomically; meta.json last). A source line is an IP or a CIDR, first in a
 * comma-separated line (Apple's CSV: prefix,country,region,city); "#" lines
 * are comments. Overlapping ranges are merged. Returns the counts per kind,
 * or null when a source is missing or has nothing (the old table stays).
 *
 * @param array<string, string> $files kind => path
 * @return array<string, array{v4: int, v6: int}>|null
 */
function anondb_build(array $files, string $dir): ?array
{
    if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
        return null;
    }
    $counts = [];
    foreach ($files as $kind => $file) {
        $in = @fopen($file, 'rb');
        if ($in === false) {
            return null;
        }
        $recs = ['v4' => [], 'v6' => []];
        while (($line = fgets($in, 1024)) !== false) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            $bounds = cidr_bounds(trim(explode(',', $line, 2)[0]));
            if ($bounds !== null) {
                $recs[strlen($bounds[0]) === 4 ? 'v4' : 'v6'][] = $bounds[0] . $bounds[1];
            }
        }
        fclose($in);
        if ($recs['v4'] === [] && $recs['v6'] === []) {
            return null;
        }
        foreach (['v4' => 4, 'v6' => 16] as $family => $len) {
            sort($recs[$family], SORT_STRING);
            $merged = [];
            foreach ($recs[$family] as $rec) {
                $start = substr($rec, 0, $len);
                $end = substr($rec, $len);
                $last = count($merged) - 1;
                if ($last >= 0 && strcmp($start, $merged[$last][1]) <= 0) {
                    if (strcmp($end, $merged[$last][1]) > 0) {
                        $merged[$last][1] = $end;
                    }
                    continue;
                }
                $merged[] = [$start, $end];
            }
            if (@file_put_contents("$dir/$kind-$family.bin.tmp", implode('', array_map(static fn (array $r) => $r[0] . $r[1], $merged))) === false) {
                return null;
            }
            $counts[$kind][$family] = count($merged);
        }
    }
    foreach (array_keys($files) as $kind) {
        foreach (['v4', 'v6'] as $family) {
            if (!@rename("$dir/$kind-$family.bin.tmp", "$dir/$kind-$family.bin")) {
                return null;
            }
        }
    }
    @file_put_contents("$dir/meta.json.tmp", (string) json_encode(['built_at' => time(), 'source' => 'Tor Project exit list, Apple iCloud Private Relay egress ranges, X4BNet lists_vpn (MIT)', 'counts' => $counts]));
    @rename("$dir/meta.json.tmp", "$dir/meta.json");
    return $counts;
}

/**
 * An IP or a CIDR ("10.0.0.0/8", "2001:db8::/32", a bare address = one) as
 * its first and last packed addresses; host bits set in the prefix are
 * ignored. null = not an address.
 *
 * @return array{0: string, 1: string}|null
 */
function cidr_bounds(string $cidr): ?array
{
    [$addr, $len] = array_pad(explode('/', $cidr, 2), 2, null);
    $bin = @inet_pton((string) $addr);
    if ($bin === false || ($bin = (string) $bin) === '') {
        return null;
    }
    $bits = strlen($bin) * 8;
    $len = $len === null ? $bits : (ctype_digit($len) ? (int) $len : -1);
    if ($len < 0 || $len > $bits) {
        return null;
    }
    $start = '';
    $end = '';
    for ($i = 0, $n = strlen($bin); $i < $n; $i++) {
        $keep = max(0, min(8, $len - $i * 8));
        $mask = (0xFF << (8 - $keep)) & 0xFF;
        $start .= chr(ord($bin[$i]) & $mask);
        $end .= chr((ord($bin[$i]) & $mask) | (~$mask & 0xFF));
    }
    return [$start, $end];
}
