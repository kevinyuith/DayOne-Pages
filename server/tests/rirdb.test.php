<?php
declare(strict_types=1);

// ── rirdb: who each IP block was delegated to (the registries' files) ──

$rdDir = rirdb_dir();
$rdSrc = sys_get_temp_dir() . '/dop-rirdb-src-' . getmypid();
@mkdir($rdSrc, 0750, true);
$comcast = 'a7b40ab58f6de4849b12c87e5806b7c0';
$cox = '4cad11d184aa000000000000000000a1';
file_put_contents("$rdSrc/arin.txt", implode("\n", [
    '2.3|arin|1791323999|9|19700101|20261006|-0400',
    'arin|*|asn|*|2|summary',
    'arin|*|ipv4|*|5|summary',
    "arin|US|asn|7922|1|20000101|allocated|$comcast",
    "arin|US|asn|22773|1|20000101|allocated|$cox",
    "arin|US|ipv4|73.0.0.0|16777216|20050419|allocated|$comcast",
    "arin|US|ipv4|68.224.0.0|524288|20030319|allocated|$cox",
    'arin|US|ipv4|48.44.0.0|262144|20251210|allocated|b66056dfa062c2b85f45bf3ec7fabacd',
    'arin|US|ipv4|23.143.16.0|768|20191008|assigned|d777ac83191162d85449347acc323c31',
    'arin|US|ipv4|10.0.0.0|256|20000101|reserved|',
    'arin||ipv4|1.2.3.0|256||available|',
    "arin|US|ipv6|2601::|20|20100101|allocated|$comcast",
]) . "\n");
file_put_contents("$rdSrc/ripencc.txt", implode("\n", [
    '2|ripencc|1791323999|5|19700101|20261006|+0200',
    'ripencc|*|ipv4|*|3|summary',
    'ripencc|UA|ipv4|95.134.0.0|131072|20090123|allocated|6874477a-e2b4-4970-a0be-29473b562790',
    'ripencc|SI|ipv4|5.249.176.0|4096|20120913|allocated|1dc61fac-1602-427a-a8f6-4accb624e742',
    'ripencc|DE|ipv4|73.255.0.0|256|20010101|allocated|overlapping-transfer',
    'ripencc|ZZ|ipv6|2a00::|12|00000000|allocated',
]) . "\r\n");

rirdb_reset();
same('no table yet: no ip_block', null, ip_block('73.11.24.27', 7922));
same('no table yet: no block', null, rirdb_block('73.11.24.27'));
same(
    'build: delegated space only (reserved/available left out), an overlap dropped',
    ['v4' => 6, 'v6' => 2, 'asn' => 2, 'holders' => 7, 'overlaps' => 1],
    rirdb_build(["$rdSrc/arin.txt", "$rdSrc/ripencc.txt"], $rdDir),
);
rirdb_reset();

same('a Comcast block', ['range' => '73.0.0.0/8', 'rir' => 'arin', 'cc' => 'US', 'date' => '2005-04-19', 'status' => 'allocated', 'holder' => $comcast], rirdb_block('73.11.24.27'));
same('first address of a block', $comcast, rirdb_block('73.0.0.0')['holder']);
same('last address of a block', $comcast, rirdb_block('73.255.255.255')['holder']);
same('the overlapping transfer was dropped: the first block answers', $comcast, rirdb_block('73.255.0.5')['holder']);
same('just past a block: none', null, rirdb_block('74.0.0.0'));
same('a reserved block: none', null, rirdb_block('10.0.0.1'));
same('before the first block', null, rirdb_block('0.0.0.1'));
same('after the last block', null, rirdb_block('223.255.255.255'));
same('a block that is not one CIDR: start-end', ['range' => '23.143.16.0-23.143.18.255', 'status' => 'assigned'], array_intersect_key(rirdb_block('23.143.17.200'), ['range' => 1, 'status' => 1]));
same('a RIPE block', ['range' => '5.249.176.0/20', 'rir' => 'ripe', 'cc' => 'SI', 'date' => '2012-09-13'], array_intersect_key(rirdb_block('5.249.176.58'), ['range' => 1, 'rir' => 1, 'cc' => 1, 'date' => 1]));
same('IPv6: a Comcast prefix', ['range' => '2601::/20', 'holder' => $comcast], array_intersect_key(rirdb_block('2601:5c1:8300:a0::1'), ['range' => 1, 'holder' => 1]));
same('IPv6: "ZZ", no date, no owner → nulls', ['cc' => null, 'date' => null, 'holder' => null], array_intersect_key(rirdb_block('2a0f::1'), ['cc' => 1, 'date' => 1, 'holder' => 1]));
same('invalid IP: none', null, rirdb_block('nope'));
same('an AS number', ['holder' => $cox, 'cc' => 'US', 'rir' => 'arin'], rirdb_asn(22773));
same('an unknown AS number', null, rirdb_asn(64500));

same('the ISP\'s own block: same', 'same', ip_block('73.11.24.27', 7922)['relation']);
same('another US owner through Comcast: other', ['cc' => 'US', 'asn_cc' => 'US', 'relation' => 'other'],array_intersect_key(ip_block('48.47.96.208', 7922), ['relation' => 1, 'cc' => 1, 'asn_cc' => 1]));
same(
    'a Ukrainian block through Cox: foreign, with both owners',
    ['range' => '95.134.0.0/15', 'rir' => 'ripe', 'cc' => 'UA', 'date' => '2009-01-23', 'status' => 'allocated', 'holder' => '6874477a-e2b4-4970-a0be-29473b562790', 'asn_holder' => $cox, 'asn_cc' => 'US', 'relation' => 'foreign'],
    ip_block('95.135.206.150', 22773),
);
same('IPv6 on its own AS: same', 'same', ip_block('2601:5c1:8300:a0::1', 7922)['relation']);
same('unknown AS: no relation', ['asn_holder' => null, 'relation' => null], array_intersect_key(ip_block('73.1.1.1', 64500), ['asn_holder' => 1, 'relation' => 1]));
same('no AS at all: no relation', null, ip_block('73.1.1.1', null)['relation']);
same('a block without an owner: no relation', null, ip_block('2a0f::1', 7922)['relation']);

same('range_prefix: everything', 0, range_prefix((string) inet_pton('0.0.0.0'), (string) inet_pton('255.255.255.255')));
same('range_prefix: one address', 32, range_prefix((string) inet_pton('8.8.8.8'), (string) inet_pton('8.8.8.8')));
same('range_prefix: a /22', 22, range_prefix((string) inet_pton('5.249.176.0'), (string) inet_pton('5.249.179.255')));
same('range_prefix: not aligned', null, range_prefix((string) inet_pton('5.249.177.0'), (string) inet_pton('5.249.178.255')));
same('range_prefix: not a power of two', null, range_prefix((string) inet_pton('23.143.16.0'), (string) inet_pton('23.143.18.255')));
same('ipv6_prefix_end: /20', '2601:fff:ffff:ffff:ffff:ffff:ffff:ffff', inet_ntop(ipv6_prefix_end((string) inet_pton('2601::'), 20)));
same('ipv6_prefix_end: /128', '2001:db8::1', inet_ntop(ipv6_prefix_end((string) inet_pton('2001:db8::1'), 128)));

// A missing input keeps the table that works.
same('a missing input: refused', null, rirdb_build(["$rdSrc/arin.txt", "$rdSrc/missing.txt"], $rdDir));
rirdb_reset();
same('…and the old table still answers', $comcast, rirdb_block('73.11.24.27')['holder']);

// Freshness: a day old gets rebuilt (after a response); a week old isn't trusted.
check('fresh table: no refresh attempt', (static function () use ($rdDir) {
    @unlink("$rdDir/attempt");
    rirdb_maybe_refresh();
    return !is_file("$rdDir/attempt");
})());
$meta = json_decode((string) file_get_contents("$rdDir/meta.json"), true);
file_put_contents("$rdDir/meta.json", json_encode(['built_at' => time() - RIRDB_MAX_AGE - 60] + $meta));
rirdb_reset();
same('a week-old table is not used', null, ip_block('73.11.24.27', 7922));

// Clean up: the other tests run without a table.
remove_tree($rdDir);
remove_tree($rdSrc);
rirdb_reset();
