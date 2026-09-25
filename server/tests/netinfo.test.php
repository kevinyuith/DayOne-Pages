<?php
declare(strict_types=1);

// ── netinfo: the DNS client, IP ranges and the rule conditions on IP, ASN and hostname ──

/** A response to query $id for $name: the question echoed, then the answers (type, rdata). */
$dnsResponse = static function (int $id, string $name, int $qtype, array $answers, int $rcode = 0, int $flags = 0x8180): string {
    $q = substr((string) dns_build_query($id, $name, $qtype), 12);
    $msg = pack('nnnnnn', $id, $flags | $rcode, 1, count($answers), 0, 0) . $q;
    foreach ($answers as [$type, $rdata]) {
        // Name = pointer to the question's name (offset 12): compression, like real resolvers.
        $msg .= "\xC0\x0C" . pack('nnNn', $type, 1, 300, strlen($rdata)) . $rdata;
    }
    return $msg;
};
$txt = static fn (string ...$parts) => implode('', array_map(fn ($p) => chr(strlen($p)) . $p, $parts));

$q = dns_build_query(0x1234, '8.8.8.8.origin.asn.cymru.com', DNS_TYPE_TXT);
same('query: header + labels + type TXT', "\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x018\x018\x018\x018\x06origin\x03asn\x05cymru\x03com\x00\x00\x10\x00\x01", $q);
same('query: an empty label is refused', null, dns_build_query(1, 'a..b', DNS_TYPE_TXT));

$r = $dnsResponse(7, '8.8.8.8.origin.asn.cymru.com', DNS_TYPE_TXT, [[DNS_TYPE_TXT, $txt('15169 | 8.8.8.0/24 | US | arin | 2023-12-28')]]);
same('TXT answer', ['15169 | 8.8.8.0/24 | US | arin | 2023-12-28'], dns_parse_answers($r, 7, DNS_TYPE_TXT));
same('TXT split in several strings is joined', ['abcdef'], dns_parse_answers($dnsResponse(7, 'x.y', DNS_TYPE_TXT, [[DNS_TYPE_TXT, $txt('abc', 'def')]]), 7, DNS_TYPE_TXT));
same('another id: not our answer', null, dns_parse_answers($r, 8, DNS_TYPE_TXT));
same('NXDOMAIN: no answer (not unknown)', [], dns_parse_answers($dnsResponse(7, 'x.y', DNS_TYPE_TXT, [], 3), 7, DNS_TYPE_TXT));
same('SERVFAIL: unknown', null, dns_parse_answers($dnsResponse(7, 'x.y', DNS_TYPE_TXT, [], 2), 7, DNS_TYPE_TXT));
same('truncated: unknown', null, dns_parse_answers($dnsResponse(7, 'x.y', DNS_TYPE_TXT, [], 0, 0x8380), 7, DNS_TYPE_TXT));
same('garbage: unknown', null, dns_parse_answers("\x00\x07", 7, DNS_TYPE_TXT));

// PTR: the rdata name compressed against the question ("...in-addr.arpa" → pointer).
$ptr = $dnsResponse(9, '8.8.8.8.in-addr.arpa', DNS_TYPE_PTR, [[5, "\x03foo\x00"], [DNS_TYPE_PTR, "\x03dns\x06google\x00"]]);
same('PTR answer (other types skipped)', ['dns.google'], dns_parse_answers($ptr, 9, DNS_TYPE_PTR));
$pos = 12;
same('name with a compression pointer', '8.8.8.8.in-addr.arpa', dns_read_name($ptr, $pos));
$loop = "\x00\x00\x81\x80\x00\x00\x00\x00\x00\x00\x00\x00\xC0\x0C";
$pos = 12;
same('pointer loop: broken, not a hang', null, dns_read_name($loop, $pos));

same('ptr name ipv4', '4.4.8.8.in-addr.arpa', ptr_name('8.8.4.4'));
same('ptr name ipv6', 'b.a.9.8.7.6.5.0.4.0.0.0.3.0.0.0.2.0.0.0.1.0.0.0.0.0.0.0.1.2.3.4.ip6.arpa', ptr_name('4321:0:1:2:3:4:567:89ab'));
same('ptr name private ip: none', null, ptr_name('10.1.2.3'));

// IP ranges.
check('ipv4 exact', ip_in_ranges('203.0.113.7', ['203.0.113.7']) === true);
check('ipv4 in /24', ip_in_ranges('203.0.113.200', ['203.0.113.0/24']) === true);
check('ipv4 outside /24', ip_in_ranges('203.0.114.1', ['203.0.113.0/24']) === false);
check('ipv4 /20 (bits inside a byte)', ip_in_ranges('10.0.15.1', ['10.0.0.0/20']) === true && ip_in_ranges('10.0.16.1', ['10.0.0.0/20']) === false);
check('ipv4 /0 = everything', ip_in_ranges('1.2.3.4', ['0.0.0.0/0']) === true);
check('ipv6 in /32', ip_in_ranges('2001:db8:abcd::1', ['2001:db8::/32']) === true);
check('ipv6 outside', ip_in_ranges('2001:db9::1', ['2001:db8::/32']) === false);
check('families never mix', ip_in_ranges('1.2.3.4', ['::/0']) === false);
check('bad entries are skipped', ip_in_ranges('1.2.3.4', ['nope', '1.2.3.4/99', '1.2.3.4']) === true);
check('invalid visitor IP: unknown', ip_in_ranges('', ['0.0.0.0/0']) === null);

// The rule conditions, with the lookups seeded (no network in the tests).
$netMemo = &netinfo_memo();
$now = time();
$netMemo['198.51.100.5'] = ['asn' => 16509, 'asn_at' => $now, 'hostname' => 'ec2-198-51-100-5.compute-1.amazonaws.com', 'hostname_at' => $now];
$netMemo['198.51.100.6'] = ['asn' => 7922, 'asn_at' => $now, 'hostname' => '', 'hostname_at' => $now];
// A lookup that failed even waiting the most a caller would: unknown, not retried now.
$netMemo['198.51.100.7'] = ['asn' => null, 'asn_at' => $now, 'asn_wait' => 3000, 'hostname' => null, 'hostname_at' => $now, 'hostname_wait' => 3000];
$netReq = static fn (string $ip) => make_request(['HTTP_CF_CONNECTING_IP' => $ip, 'REMOTE_ADDR' => $ip]);

check('ips: in the list', rule_conditions_match(['ips' => ['198.51.100.0/24']], $netReq('198.51.100.5')));
check('ips: not in the list', !rule_conditions_match(['ips' => ['203.0.113.0/24']], $netReq('198.51.100.5')));
check('ips block: outside the list matches', rule_conditions_match(['ips' => ['203.0.113.0/24'], 'ips_mode' => 'block'], $netReq('198.51.100.5')));
check('ips block: inside the list doesn\'t', !rule_conditions_match(['ips' => ['198.51.100.5'], 'ips_mode' => 'block'], $netReq('198.51.100.5')));

check('asns: AWS is one of 16509, 15169', rule_conditions_match(['asns' => [16509, 15169]], $netReq('198.51.100.5')));
check('asns: Comcast isn\'t', !rule_conditions_match(['asns' => [16509, 15169]], $netReq('198.51.100.6')));
check('asns block: Comcast is not one of the clouds', rule_conditions_match(['asns' => [16509, 15169], 'asns_mode' => 'block'], $netReq('198.51.100.6')));
check('asns: lookup failed → no match, either way', !rule_conditions_match(['asns' => [16509]], $netReq('198.51.100.7')) && !rule_conditions_match(['asns' => [16509], 'asns_mode' => 'block'], $netReq('198.51.100.7')));

check('hostname matches amazonaws', rule_conditions_match(['hostname' => 'amazonaws|googleusercontent'], $netReq('198.51.100.5')));
check('hostname: case-insensitive', rule_conditions_match(['hostname' => 'COMPUTE-1'], $netReq('198.51.100.5')));
check('hostname: no PTR matches nothing', !rule_conditions_match(['hostname' => '.'], $netReq('198.51.100.6')));
check('hostname block: no PTR "doesn\'t match" amazonaws', rule_conditions_match(['hostname' => 'amazonaws', 'hostname_mode' => 'block'], $netReq('198.51.100.6')));
check('hostname: lookup failed → no match, either way', !rule_conditions_match(['hostname' => 'x'], $netReq('198.51.100.7')) && !rule_conditions_match(['hostname' => 'x', 'hostname_mode' => 'block'], $netReq('198.51.100.7')));

check('all together (AND): AWS by ASN + hostname + range', rule_conditions_match(['ips' => ['198.51.100.0/24'], 'asns' => [16509], 'hostname' => 'amazonaws'], $netReq('198.51.100.5')));

// The lookups are skipped when a cheaper condition already failed: an unseeded public IP would go to the network.
$netMemo = [];
check('cheap conditions first: a failing UA never reaches the ASN lookup', !rule_conditions_match(['user_agent' => 'nomatchxyz', 'asns' => [16509]], $netReq('192.0.2.200')) && !isset(netinfo_memo()['192.0.2.200']));

// Private IPs: no ASN, no hostname, without any query.
same('private IP: ASN none (0)', 0, netinfo_asn('10.0.0.1', 50));
same('private IP: no hostname', '', netinfo_hostname('10.0.0.1', 50));
same('invalid IP: unknown', null, netinfo_asn('not-an-ip', 50));

// The cache: an answer lasts a day, a failed lookup 10 minutes.
check('fresh answer', netinfo_fresh(['asn' => 15169, 'asn_at' => time() - 3600], 'asn'));
check('old answer', !netinfo_fresh(['asn' => 15169, 'asn_at' => time() - NETINFO_TTL - 1], 'asn'));
check('a failure with a short wait is retried by a caller that can wait longer', !netinfo_fresh(['asn' => null, 'asn_at' => time(), 'asn_wait' => 400], 'asn', 1500) && netinfo_fresh(['asn' => null, 'asn_at' => time(), 'asn_wait' => 1500], 'asn', 1500));
check('an answer is never retried just for a longer wait', netinfo_fresh(['asn' => 15169, 'asn_at' => time(), 'asn_wait' => 400], 'asn', 1500));
same('rule timeout: 400 ms by default', 400, netinfo_rule_timeout());
putenv('NETINFO_RULE_TIMEOUT_MS=800');
same('rule timeout: configurable', 800, netinfo_rule_timeout());
putenv('NETINFO_RULE_TIMEOUT_MS=99999');
same('rule timeout: out of range → default', 400, netinfo_rule_timeout());
putenv('NETINFO_RULE_TIMEOUT_MS');
check('a failed lookup is retried after 10 minutes', netinfo_fresh(['asn' => null, 'asn_at' => time() - 60], 'asn') && !netinfo_fresh(['asn' => null, 'asn_at' => time() - NETINFO_FAIL_TTL - 1], 'asn'));
netinfo_store('198.51.100.9', ['asn' => 64500, 'asn_at' => time()]);
$netMemo = [];
same('stored on disk and read back', 64500, netinfo_entry('198.51.100.9')['asn'] ?? null);
$netMemo = [];
