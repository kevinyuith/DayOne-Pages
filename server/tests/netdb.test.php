<?php
declare(strict_types=1);

// ── netdb: the local IP → ASN / country table ──

$ndDir = netdb_dir();
$ndSrc = sys_get_temp_dir() . '/dop-netdb-src-' . getmypid();
@mkdir($ndSrc, 0750, true);
$u32 = static fn (string $ip) => (string) unpack('N', (string) inet_pton($ip))[1];
file_put_contents("$ndSrc/v4.gz", gzencode(implode("\n", [
    $u32('1.0.0.0') . "\t" . $u32('1.0.0.255') . "\t13335\tUS\tCLOUDFLARENET",
    $u32('1.0.1.0') . "\t" . $u32('1.0.3.255') . "\t0\tNone\tNot routed",
    $u32('8.8.8.0') . "\t" . $u32('8.8.8.255') . "\t15169\tUS\tGOOGLE",
    $u32('177.0.0.0') . "\t" . $u32('177.1.255.255') . "\t28573\tBR\tClaro NXT Telecomunicacoes Ltda",
    $u32('203.0.113.0') . "\t" . $u32('203.0.113.255') . "\t64500\tUnknown\tSomewhere",
]) . "\n"));
file_put_contents("$ndSrc/v6.gz", gzencode(implode("\n", [
    "::\t::1\t0\tNone\tNot routed",
    "2001:4860::\t2001:4860:ffff:ffff:ffff:ffff:ffff:ffff\t15169\tUS\tGOOGLE",
    "2804:14c::\t2804:14c:ffff:ffff:ffff:ffff:ffff:ffff\t28573\tBR\tClaro NXT Telecomunicacoes Ltda",
]) . "\n"));

netdb_reset();
same('no table yet: lookups say "fall back"', null, netdb_lookup('8.8.8.8'));
same('build: routed ranges only (AS 0 left out), names once', ['v4' => 4, 'v6' => 2, 'names' => 4], netdb_build("$ndSrc/v4.gz", "$ndSrc/v6.gz", $ndDir));
netdb_reset();

same('8.8.8.8 → AS15169, US', ['asn' => 15169, 'cc' => 'US'], netdb_lookup('8.8.8.8'));
same('first address of a range', 15169, netdb_lookup('8.8.8.0')['asn']);
same('last address of a range', 15169, netdb_lookup('8.8.8.255')['asn']);
same('just past the range: no ASN', ['asn' => 0, 'cc' => null], netdb_lookup('8.8.9.0'));
same('a not-routed range: no ASN', 0, netdb_lookup('1.0.2.5')['asn']);
same('before the first range', 0, netdb_lookup('0.1.2.3')['asn']);
same('after the last range', 0, netdb_lookup('223.1.1.1')['asn']);
same('a range in the middle of a bigger block', ['asn' => 28573, 'cc' => 'BR'], netdb_lookup('177.1.200.9'));
same('country "Unknown" → null', ['asn' => 64500, 'cc' => null], netdb_lookup('203.0.113.9'));
same('IPv6 → AS15169, US', ['asn' => 15169, 'cc' => 'US'], netdb_lookup('2001:4860:4860::8888'));
same('IPv6 Claro', 28573, netdb_lookup('2804:14c:10a:8de1:146:c16d:643c:4e1')['asn']);
same('IPv6 outside every range', 0, netdb_lookup('2a00::1')['asn']);
same('private IP: no ASN', 0, netdb_lookup('10.0.0.1')['asn']);
same('invalid IP: no ASN', 0, netdb_lookup('nope')['asn']);
same('AS name', 'GOOGLE', netdb_as_name(15169));
same('AS name with spaces', 'Claro NXT Telecomunicacoes Ltda', netdb_as_name(28573));
same('unknown AS: no name', null, netdb_as_name(99999));

// netinfo takes the table first: no DNS (a 1 ms timeout would fail any query).
$netMemo = &netinfo_memo();
$netMemo = [];
same('netinfo_asn from the table, no network', 15169, netinfo_asn('8.8.8.8', 1));
same('netinfo_as_name from the table', 'GOOGLE', netinfo_as_name('8.8.8.8', 1));
check('netinfo_asn: nothing cached per IP (the table needs no cache)', !isset(netinfo_memo()['8.8.8.8']['asn']));
same('netinfo_known: ASN and name known, the hostname still missing', ['asn' => 15169, 'as_name' => 'GOOGLE', 'hostname' => null, 'complete' => false], netinfo_known('8.8.8.8'));
$netMemo['8.8.8.8'] = ['hostname' => 'dns.google', 'hostname_at' => time()];
same('netinfo_known: + a cached hostname → complete', ['asn' => 15169, 'as_name' => 'GOOGLE', 'hostname' => 'dns.google', 'complete' => true], netinfo_known('8.8.8.8'));
$netMemo = [];
check('rule ASN condition from the table', rule_conditions_match(['asns' => [28573]], make_request(['HTTP_CF_CONNECTING_IP' => '177.1.2.3'])));

// The country: Cloudflare's header first, the table without it.
same('country: CF-IPCountry wins', 'PT', make_request(['HTTP_CF_IPCOUNTRY' => 'pt', 'HTTP_CF_CONNECTING_IP' => '177.1.2.3'])->country);
same('country: no header → the network\'s country', 'BR', make_request(['HTTP_CF_CONNECTING_IP' => '177.1.2.3'])->country);
same('country: no header, unknown IP → empty', '', make_request(['HTTP_CF_CONNECTING_IP' => '10.0.0.1'])->country);

// A broken (unsorted) input keeps the table that works.
file_put_contents("$ndSrc/bad.gz", gzencode($u32('9.9.9.0') . "\t" . $u32('9.9.9.255') . "\t19281\tUS\tQUAD9\n" . $u32('8.8.8.0') . "\t" . $u32('8.8.8.255') . "\t15169\tUS\tGOOGLE\n"));
same('unsorted input: refused', null, netdb_build("$ndSrc/bad.gz", "$ndSrc/v6.gz", $ndDir));
netdb_reset();
same('…and the old table still answers', 15169, netdb_lookup('8.8.8.8')['asn']);

// Freshness: a day old gets rebuilt (after a response); a week old isn't trusted.
check('fresh table: no refresh attempt', (static function () use ($ndDir) {
    @unlink("$ndDir/attempt");
    netdb_maybe_refresh();
    return !is_file("$ndDir/attempt");
})());
$meta = json_decode((string) file_get_contents("$ndDir/meta.json"), true);
file_put_contents("$ndDir/meta.json", json_encode(['built_at' => time() - NETDB_MAX_AGE - 60] + $meta));
netdb_reset();
same('a week-old table is not used (fall back to DNS)', null, netdb_lookup('8.8.8.8'));

// Clean up: the other tests run without a table.
remove_tree($ndDir);
remove_tree($ndSrc);
netdb_reset();
