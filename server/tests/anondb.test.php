<?php
declare(strict_types=1);

// ── anondb: known VPNs, Tor exits, ISP proxies, relays and hosting ──

$adDir = anondb_dir();
$adSrc = sys_get_temp_dir() . '/dop-anondb-src-' . getmypid();
@mkdir($adSrc, 0750, true);
$adFiles = ['tor' => "$adSrc/tor.txt", 'relay' => "$adSrc/relay.csv", 'vpn' => "$adSrc/vpn.txt", 'hosting' => "$adSrc/hosting.txt"];
file_put_contents($adFiles['tor'], "# exit list\n185.220.101.1\n185.220.101.2\n");
file_put_contents($adFiles['relay'], "172.224.226.0/27,GB,GB-EN,London,\n172.224.226.32/31,GB,GB-SC,Aberdeen,\n2a02:26f7:b3c0:4000::/64,US,US-CA,Los Angeles,\n");
// 45.131.194.0/24 sits inside the /22 (merged); the relay's /24 is also on the VPN list (the relay wins).
file_put_contents($adFiles['vpn'], "45.131.192.0/22\n45.131.194.0/24\n172.224.226.0/24\n104.28.0.0/16\n");
file_put_contents($adFiles['hosting'], "34.192.0.0/10\r\n35.80.0.0/12\r\n");
$netutilsHolder = '6874477a-e2b4-4970-a0be-29473b562790';

anondb_reset();
same('no table yet: unknown (null)', null, anon_classify('185.220.101.1', null, null));
same(
    'build: each kind\'s ranges, overlaps merged',
    ['tor' => ['v4' => 2, 'v6' => 0], 'relay' => ['v4' => 2, 'v6' => 1], 'vpn' => ['v4' => 3, 'v6' => 0], 'hosting' => ['v4' => 2, 'v6' => 0]],
    anondb_build($adFiles, $adDir),
);
anondb_reset();

same('a Tor exit', ['is_vpn' => true, 'kind' => 'tor', 'name' => 'Tor'], anon_classify('185.220.101.2', 60729, null));
same('iCloud Private Relay is not a VPN', ['is_vpn' => false, 'kind' => 'relay', 'name' => 'iCloud Private Relay'], anon_classify('172.224.226.33', 36183, null));
same('…even where a VPN list also has the range', 'relay', anon_classify('172.224.226.5', 13335, null)['kind']);
same('…and on IPv6', 'relay', anon_classify('2a02:26f7:b3c0:4000::99', 54113, null)['kind']);
same('a VPN\'s own AS, named', ['is_vpn' => true, 'kind' => 'vpn', 'name' => 'PacketHub (NordVPN)'], anon_classify('146.70.1.1', 136787, null));
same('on the VPN list: named by the AS (no table here: its number)', ['is_vpn' => true, 'kind' => 'vpn', 'name' => 'AS212238'], anon_classify('45.131.195.9', 212238, null));
same('on the VPN list, no AS known: no name', ['is_vpn' => true, 'kind' => 'vpn', 'name' => null], anon_classify('45.131.192.1', null, null));
same(
    'a leasing company\'s block through a residential ISP: ISP proxy',
    ['is_vpn' => true, 'kind' => 'isp_proxy', 'name' => 'netutils'],
    anon_classify('95.135.206.150', 22773, ['relation' => 'foreign', 'holder' => $netutilsHolder]),
);
same('…"other" counts too', 'isp_proxy', anon_classify('95.135.206.150', 22773, ['relation' => 'other', 'holder' => $netutilsHolder])['kind']);
same('…but not the owner\'s own AS', null, anon_classify('95.135.206.150', 6877, ['relation' => 'same', 'holder' => $netutilsHolder])['kind']);
same('…nor an owner that leases nothing', null, anon_classify('73.11.24.27', 7922, ['relation' => 'other', 'holder' => 'b66056dfa062c2b85f45bf3ec7fabacd'])['kind']);
same('a VPN on leased space is a VPN', 'vpn', anon_classify('45.131.195.9', 212238, ['relation' => 'foreign', 'holder' => $netutilsHolder])['kind']);
same('hosting: marked, not a VPN', ['is_vpn' => false, 'kind' => 'hosting', 'name' => 'AS16509'], anon_classify('34.220.185.55', 16509, null));
same('a home connection: none', ['is_vpn' => false, 'kind' => null, 'name' => null], anon_classify('73.11.24.27', 7922, ['relation' => 'same', 'holder' => 'x']));
same('an IPv6 home connection: none', null, anon_classify('2601:5c1:8300:a0::1', 7922, null)['kind']);
same('invalid IP: none', ['is_vpn' => false, 'kind' => null, 'name' => null], anon_classify('nope', null, null));

same('cidr_bounds: a /8', ['10.0.0.0', '10.255.255.255'], array_map('inet_ntop', cidr_bounds('10.0.0.0/8')));
same('cidr_bounds: host bits ignored', ['10.0.0.0', '10.255.255.255'], array_map('inet_ntop', cidr_bounds('10.1.2.3/8')));
same('cidr_bounds: a bare address', ['8.8.8.8', '8.8.8.8'], array_map('inet_ntop', cidr_bounds('8.8.8.8')));
same('cidr_bounds: IPv6', ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'], array_map('inet_ntop', cidr_bounds('2001:db8::/32')));
same('cidr_bounds: not an address', null, cidr_bounds('nope'));
same('cidr_bounds: prefix too long', null, cidr_bounds('10.0.0.0/33'));

// A missing source keeps the table that works.
same('a missing source: refused', null, anondb_build(['tor' => "$adSrc/missing.txt"] + $adFiles, $adDir));
anondb_reset();
same('…and the old table still answers', 'tor', anon_classify('185.220.101.1', null, null)['kind']);

// Freshness: a day old gets rebuilt (after a response); a week old isn't trusted.
check('fresh table: no refresh attempt', (static function () use ($adDir) {
    @unlink("$adDir/attempt");
    anondb_maybe_refresh();
    return !is_file("$adDir/attempt");
})());
$meta = json_decode((string) file_get_contents("$adDir/meta.json"), true);
file_put_contents("$adDir/meta.json", json_encode(['built_at' => time() - ANONDB_MAX_AGE - 60] + $meta));
anondb_reset();
same('a week-old table is not used', null, anon_classify('185.220.101.1', null, null));

// Clean up: the other tests run without a table.
remove_tree($adDir);
remove_tree($adSrc);
anondb_reset();
