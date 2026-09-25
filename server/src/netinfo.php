<?php
/**
 * What the network says about the click's IP — its ASN (Team Cymru, over
 * DNS) and its hostname (reverse DNS, PTR) — for the rules and the traffic
 * log, plus IP/CIDR matching for the rules.
 *
 * A small DNS client over UDP with a timeout: dns_get_record and
 * gethostbyaddr take none, and a rule needs the answer BEFORE the response
 * (a slow resolver would hold the visitor). Each answer is kept per IP on
 * disk (cache/ip/…: a day; a failed lookup, 10 minutes) and in memory for the
 * request, so a rule and the log after the response don't look the same IP
 * up twice.
 *
 * A lookup that fails (timeout, SERVFAIL, no resolver) is null = unknown; a
 * name that doesn't exist (NXDOMAIN, or a private IP) is an answer: no ASN (0)
 * / no hostname ('').
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const NETINFO_TTL = 86400;
const NETINFO_FAIL_TTL = 600;
/** After the response (the log): no one is waiting. Before it, a rule waits netinfo_rule_timeout(). */
const NETINFO_LOG_TIMEOUT_MS = 1500;

const DNS_TYPE_PTR = 12;
const DNS_TYPE_TXT = 16;

// ── ASN and hostname, cached per IP ─────────────────────────────────────────

/** How long a rule may wait for a lookup, before the response: NETINFO_RULE_TIMEOUT_MS (50–3000), 400 ms by default. */
function netinfo_rule_timeout(): int
{
    $v = (int) getenv('NETINFO_RULE_TIMEOUT_MS');
    return $v >= 50 && $v <= 3000 ? $v : 400;
}

/** The IP's AS number: > 0; 0 = none (private IP, no route); null = unknown (the lookup failed). */
function netinfo_asn(string $ip, int $timeoutMs): ?int
{
    $e = netinfo_entry($ip);
    if (!netinfo_fresh($e, 'asn', $timeoutMs)) {
        $zone = cymru_origin_name($ip);
        if ($zone === null) {
            $asn = filter_var($ip, FILTER_VALIDATE_IP) === false ? null : 0;
        } else {
            $txt = dns_query($zone, DNS_TYPE_TXT, $timeoutMs);
            $asn = $txt === null ? null : (parse_cymru_origin($txt[0] ?? null) ?? 0);
        }
        $e = netinfo_store($ip, ['asn' => $asn, 'asn_at' => time(), 'asn_wait' => $timeoutMs]);
    }
    return $e['asn'];
}

/** The name of the IP's AS (for the log), or null. */
function netinfo_as_name(string $ip, int $timeoutMs): ?string
{
    $asn = netinfo_asn($ip, $timeoutMs);
    if (!$asn) {
        return null;
    }
    $e = netinfo_entry($ip);
    if (!netinfo_fresh($e, 'as_name', $timeoutMs)) {
        $txt = dns_query("AS$asn.asn.cymru.com", DNS_TYPE_TXT, $timeoutMs);
        $e = netinfo_store($ip, ['as_name' => $txt === null ? null : parse_cymru_as_name($txt[0] ?? null), 'as_name_at' => time(), 'as_name_ok' => $txt !== null, 'as_name_wait' => $timeoutMs]);
    }
    return $e['as_name'];
}

/** The IP's hostname (PTR, lowercase): the name; '' = none (no PTR, private IP); null = unknown (the lookup failed). */
function netinfo_hostname(string $ip, int $timeoutMs): ?string
{
    $e = netinfo_entry($ip);
    if (!netinfo_fresh($e, 'hostname', $timeoutMs)) {
        $name = ptr_name($ip);
        if ($name === null) {
            $host = filter_var($ip, FILTER_VALIDATE_IP) === false ? null : '';
        } else {
            $ptr = dns_query($name, DNS_TYPE_PTR, $timeoutMs);
            $host = $ptr === null ? null : strtolower(rtrim((string) ($ptr[0] ?? ''), '.'));
        }
        $e = netinfo_store($ip, ['hostname' => $host, 'hostname_at' => time(), 'hostname_wait' => $timeoutMs]);
    }
    return $e['hostname'];
}

/**
 * What the per-IP cache already knows, with no lookup: the log writes the hit
 * with it right away and looks the rest up after (complete = nothing to look up).
 *
 * @return array{asn: ?int, as_name: ?string, hostname: ?string, complete: bool}
 */
function netinfo_known(string $ip): array
{
    $e = netinfo_entry($ip);
    $asnOk = netinfo_fresh($e, 'asn') && $e['asn'] !== null;
    $hostOk = netinfo_fresh($e, 'hostname') && $e['hostname'] !== null;
    $asn = $asnOk && $e['asn'] > 0 ? (int) $e['asn'] : null;
    $nameOk = $asn === null || (netinfo_fresh($e, 'as_name') && ($e['as_name_ok'] ?? false));
    return [
        'asn' => $asn,
        'as_name' => $asn !== null && $nameOk ? ($e['as_name'] ?? null) : null,
        'hostname' => $hostOk && $e['hostname'] !== '' ? $e['hostname'] : null,
        'complete' => $asnOk && $hostOk && $nameOk,
    ];
}

/**
 * Is a field still good? An answer lasts NETINFO_TTL; a failed lookup
 * (null) only NETINFO_FAIL_TTL, so it's tried again soon — and right away by
 * a caller that can wait longer than the one that failed (a rule's short
 * timeout doesn't keep the log, after the response, from trying).
 */
function netinfo_fresh(array $e, string $field, int $timeoutMs = 0): bool
{
    if (!array_key_exists($field, $e) || !isset($e[$field . '_at'])) {
        return false;
    }
    $failed = $field === 'as_name' ? !($e['as_name_ok'] ?? false) : $e[$field] === null;
    if ($failed && $timeoutMs > (int) ($e[$field . '_wait'] ?? 0)) {
        return false;
    }
    return time() - (int) $e[$field . '_at'] < ($failed ? NETINFO_FAIL_TTL : NETINFO_TTL);
}

/** The IP's entry: memory first, then disk. */
function netinfo_entry(string $ip): array
{
    $memo = &netinfo_memo();
    if (isset($memo[$ip])) {
        return $memo[$ip];
    }
    $raw = @file_get_contents(netinfo_file($ip));
    $json = is_string($raw) ? cache_unwrap($raw) : null;
    $e = $json !== null ? json_decode($json, true) : null;
    return $memo[$ip] = is_array($e) ? $e : [];
}

/** Merges fields into the IP's entry (memory + disk) and returns it. */
function netinfo_store(string $ip, array $fields): array
{
    $memo = &netinfo_memo();
    $e = array_merge(netinfo_entry($ip), $fields);
    $memo[$ip] = $e;
    if (cache_writable()) {
        atomic_write(netinfo_file($ip), cache_wrap((string) json_encode($e)));
    }
    return $e;
}

/** The request's entries (tests seed and reset it). */
function &netinfo_memo(): array
{
    static $memo = [];
    return $memo;
}

function netinfo_file(string $ip): string
{
    $h = sha1($ip);
    return cache_dir() . '/ip/' . substr($h, 0, 2) . "/$h.php";
}

/** Cleanup of the per-IP cache: entries untouched for over two days. */
function netinfo_gc(): int
{
    $dir = cache_dir() . '/ip';
    if (!is_dir($dir)) {
        return 0;
    }
    $limit = time() - 2 * NETINFO_TTL;
    $count = 0;
    $items = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($items as $item) {
        if ($item->isDir()) {
            @rmdir($item->getPathname());
        } elseif ($item->getMTime() < $limit && @unlink($item->getPathname())) {
            $count++;
        }
    }
    return $count;
}

// ── Team Cymru and PTR names ─────────────────────────────────────────────────

/** 8.8.8.8 → 8.8.8.8.origin.asn.cymru.com (reversed octets); IPv6 → reversed nibbles in origin6. Private/reserved IP → null. */
function cymru_origin_name(string $ip): ?string
{
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        return null;
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        return implode('.', array_reverse(explode('.', $ip))) . '.origin.asn.cymru.com';
    }
    return implode('.', str_split(strrev(bin2hex((string) inet_pton($ip))))) . '.origin6.asn.cymru.com';
}

/** 8.8.4.4 → 4.4.8.8.in-addr.arpa; IPv6 → reversed nibbles in ip6.arpa. Private/reserved IP → null (no public hostname). */
function ptr_name(string $ip): ?string
{
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        return null;
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        return implode('.', array_reverse(explode('.', $ip))) . '.in-addr.arpa';
    }
    return implode('.', str_split(strrev(bin2hex((string) inet_pton($ip))))) . '.ip6.arpa';
}

/** "15169 | 8.8.8.0/24 | US | arin | 2023-12-28" → 15169. Prefix with more than one ASN ("15169 36040") → the first. */
function parse_cymru_origin(?string $txt): ?int
{
    if ($txt === null || preg_match('/^\s*(\d+)/', $txt, $m) !== 1) {
        return null;
    }
    $asn = (int) $m[1];
    return $asn > 0 ? $asn : null;
}

/** "15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US" → "GOOGLE - Google LLC, US". */
function parse_cymru_as_name(?string $txt): ?string
{
    $name = trim(explode('|', (string) $txt)[4] ?? '');
    return $name !== '' ? $name : null;
}

// ── IP ranges ────────────────────────────────────────────────────────────────

/**
 * Is the IP in one of the entries ("1.2.3.4", "10.0.0.0/8", "2001:db8::/32")?
 * null = the IP itself isn't valid (the condition can't be told).
 */
function ip_in_ranges(string $ip, array $ranges): ?bool
{
    $bin = @inet_pton($ip);
    if ($bin === false || $bin === '') {
        return null;
    }
    foreach ($ranges as $range) {
        if (is_string($range) && ip_in_cidr($bin, $range)) {
            return true;
        }
    }
    return false;
}

/** The packed IP against one IP or CIDR range (same family only). */
function ip_in_cidr(string $bin, string $range): bool
{
    [$net, $bits] = array_pad(explode('/', trim($range), 2), 2, null);
    $netBin = @inet_pton((string) $net);
    if ($netBin === false || strlen($netBin) !== strlen($bin)) {
        return false;
    }
    $max = strlen($bin) * 8;
    $bits = $bits === null ? $max : (ctype_digit($bits) ? (int) $bits : -1);
    if ($bits < 0 || $bits > $max) {
        return false;
    }
    $full = intdiv($bits, 8);
    if (strncmp($bin, $netBin, $full) !== 0) {
        return false;
    }
    $rest = $bits % 8;
    if ($rest === 0) {
        return true;
    }
    $mask = (0xFF << (8 - $rest)) & 0xFF;
    return (ord($bin[$full]) & $mask) === (ord($netBin[$full]) & $mask);
}

// ── A small DNS client (UDP, with a timeout) ─────────────────────────────────

/** The resolver: DNS_RESOLVER, else the first nameserver of /etc/resolv.conf, else 1.1.1.1. */
function dns_resolver(): string
{
    static $ns = null;
    if ($ns !== null) {
        return $ns;
    }
    $env = trim((string) getenv('DNS_RESOLVER'));
    if (filter_var($env, FILTER_VALIDATE_IP) !== false) {
        return $ns = $env;
    }
    $conf = @file_get_contents('/etc/resolv.conf');
    if (is_string($conf) && preg_match('/^\s*nameserver\s+([0-9a-fA-F:.]+)/m', $conf, $m) === 1 && filter_var($m[1], FILTER_VALIDATE_IP) !== false) {
        return $ns = $m[1];
    }
    return $ns = '1.1.1.1';
}

/**
 * The answers (TXT strings or PTR names) of one query. null = no answer in
 * time or an error (unknown); [] = the name doesn't exist or has none.
 *
 * @return list<string>|null
 */
function dns_query(string $name, int $type, int $timeoutMs): ?array
{
    $id = random_int(0, 0xFFFF);
    $packet = dns_build_query($id, $name, $type);
    if ($packet === null) {
        return null;
    }
    $ns = dns_resolver();
    $sock = @stream_socket_client(str_contains($ns, ':') ? "udp://[$ns]:53" : "udp://$ns:53", $errno, $errstr, max(0.05, $timeoutMs / 1000));
    if ($sock === false) {
        return null;
    }
    stream_set_timeout($sock, intdiv($timeoutMs, 1000), ($timeoutMs % 1000) * 1000);
    $answer = null;
    if (@fwrite($sock, $packet) === strlen($packet)) {
        $resp = @fread($sock, 4096);
        $timedOut = (bool) (stream_get_meta_data($sock)['timed_out'] ?? false);
        if (is_string($resp) && $resp !== '' && !$timedOut) {
            $answer = dns_parse_answers($resp, $id, $type);
        }
    }
    fclose($sock);
    return $answer;
}

/** A standard query (recursion desired) for one name and type; null if the name can't be encoded. */
function dns_build_query(int $id, string $name, int $type): ?string
{
    $q = pack('nnnnnn', $id, 0x0100, 1, 0, 0, 0);
    foreach (explode('.', rtrim($name, '.')) as $label) {
        if ($label === '' || strlen($label) > 63) {
            return null;
        }
        $q .= chr(strlen($label)) . $label;
    }
    return $q . "\0" . pack('nn', $type, 1);
}

/**
 * The answers of the asked type in a response: TXT = the joined strings, PTR
 * = the name. null = not our answer, an error or a truncated/broken message;
 * [] = NXDOMAIN or no record of that type.
 *
 * @return list<string>|null
 */
function dns_parse_answers(string $msg, int $id, int $type): ?array
{
    $len = strlen($msg);
    if ($len < 12) {
        return null;
    }
    $h = unpack('nid/nflags/nqd/nan', $msg);
    if ($h['id'] !== $id || ($h['flags'] & 0x8000) === 0 || ($h['flags'] & 0x0200) !== 0) {
        return null;
    }
    $rcode = $h['flags'] & 0xF;
    if ($rcode === 3) {
        return [];
    }
    if ($rcode !== 0) {
        return null;
    }
    $pos = 12;
    for ($i = 0; $i < $h['qd']; $i++) {
        if (dns_read_name($msg, $pos) === null || $pos + 4 > $len) {
            return null;
        }
        $pos += 4;
    }
    $out = [];
    for ($i = 0; $i < $h['an']; $i++) {
        if (dns_read_name($msg, $pos) === null || $pos + 10 > $len) {
            return null;
        }
        $rr = unpack('ntype/nclass/Nttl/nrdlen', substr($msg, $pos, 10));
        $pos += 10;
        $end = $pos + $rr['rdlen'];
        if ($end > $len) {
            return null;
        }
        if ($rr['type'] === $type && $type === DNS_TYPE_TXT) {
            $txt = '';
            for ($p = $pos; $p < $end; $p += 1 + ord($msg[$p])) {
                $txt .= substr($msg, $p + 1, ord($msg[$p]));
            }
            $out[] = $txt;
        } elseif ($rr['type'] === $type && $type === DNS_TYPE_PTR) {
            $p = $pos;
            $name = dns_read_name($msg, $p);
            if ($name !== null) {
                $out[] = $name;
            }
        }
        $pos = $end;
    }
    return $out;
}

/** A domain name at $pos (following compression pointers); moves $pos past it. null = broken. */
function dns_read_name(string $msg, int &$pos): ?string
{
    $len = strlen($msg);
    $labels = [];
    $p = $pos;
    $jumped = false;
    for ($hops = 0; ; ) {
        if ($p >= $len) {
            return null;
        }
        $l = ord($msg[$p]);
        if ($l === 0) {
            $p++;
            break;
        }
        if (($l & 0xC0) === 0xC0) {
            if ($p + 1 >= $len || ++$hops > 32) {
                return null;
            }
            if (!$jumped) {
                $pos = $p + 2;
                $jumped = true;
            }
            $p = (($l & 0x3F) << 8) | ord($msg[$p + 1]);
            continue;
        }
        if ($p + 1 + $l > $len) {
            return null;
        }
        $labels[] = substr($msg, $p + 1, $l);
        $p += 1 + $l;
    }
    if (!$jumped) {
        $pos = $p;
    }
    return implode('.', $labels);
}
