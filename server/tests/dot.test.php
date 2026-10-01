<?php
declare(strict_types=1);

// ── dot.php: a click with a platform click id → event "click" for dayone-main's tracker ──

// Which parameters are click ids: any platform's, case-insensitive, non-empty; the first (dot's order) is ext_click_id.
same('click ids: fbclid', ['fbclid' => 'abc'], dot_click_ids(['fbclid' => 'abc', 'sub1' => 'x']));
same('click ids: name case-insensitive', ['ttclid' => 'T1'], dot_click_ids(['TTCLID' => 'T1']));
same('click ids: empty ignored', [], dot_click_ids(['gclid' => '', 'fbclid' => '  ']));
same('click ids: dot\'s order (ext_click_id, gclid…, ref_id last)', ['ext_click_id', 'gclid', 'fbclid', 'snclid', 'ref_id'], array_keys(dot_click_ids(['ref_id' => 'r', 'snclid' => 's', 'fbclid' => 'f', 'gclid' => 'g', 'ext_click_id' => 'e'])));
foreach (['wbraid', 'gbraid', 'tbclid', 'snclid', 'msclkid', 'twclid', 'rdt_cid', 'epik', 'li_fat_id', 'sccid', 'tblci', 'click_id'] as $k) {
    check("click ids: $k", dot_click_ids([$k => 'v']) === [$k => 'v']);
}
same('click ids: an array value is not one', [], dot_click_ids(['fbclid' => ['a']]));

// No click id, not a page, or the www entry redirect: nothing is sent.
$dotReq = static fn (string $uri, array $more = []) => make_request(['REQUEST_URI' => $uri, 'HTTP_HOST' => 'shop.example'] + $more);
same('no click id: nothing', null, dot_click_payload($dotReq('/?sub1=x'), [], []));
same('an asset with a click id: nothing', null, dot_click_payload($dotReq('/app.js?fbclid=x'), [], []));
same('the www entry redirect: nothing (the same click comes back on the bare domain)', null, dot_click_payload($dotReq('/?fbclid=x', ['HTTP_HOST' => 'www.shop.example']), ['route' => ['action' => 'REDIRECT', 'match_type' => 'WWW']], []));
same('a prefetch: nothing (not a click; dot keeps the first event of a click id)', null, dot_click_payload($dotReq('/?ttclid=x', ['HTTP_X_MOZ' => 'prefetch']), ['route' => ['action' => 'SERVE', 'match_type' => 'GATE']], []));

// A click that went to the funnel: every field the sites' click events have.
$dotServer = [
    'HTTP_HOST' => 'shop.example', 'HTTP_USER_AGENT' => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15',
    'HTTP_ACCEPT' => 'text/html', 'HTTP_CF_RAY' => 'abc-EWR', 'HTTP_COOKIE' => 'dotid=aebe26bd-d0245268-71fa28c5-09252103; dop_pg=x',
    'HTTP_AUTHORIZATION' => 'secret', 'HTTP_CF_REGION' => 'Texas', 'REQUEST_TIME_FLOAT' => 1790000000.25,
];
$uri = '/?cmpid=67126e08&rtkcid=6a97&sub1=' . rawurlencode('[TT 50] [F9] [CBO]') . '&sub2=Ad+group+2&sub3=ad.mp4&sub4=111&sub5=222&sub6=333&sub10=TikTok&sub11=TikTok&ttclid=E_C_P_abc';
$req = make_request(['REQUEST_URI' => $uri, 'HTTP_HOST' => 'shop.example', 'HTTP_USER_AGENT' => $dotServer['HTTP_USER_AGENT'], 'HTTP_COOKIE' => $dotServer['HTTP_COOKIE'], 'HTTP_REFERER' => 'https://www.tiktok.com/', 'HTTP_CF_CONNECTING_IP' => '203.0.113.9', 'HTTP_CF_IPCOUNTRY' => 'US']);
$route = ['action' => 'SERVE', 'match_type' => 'GATE', 'page_id' => 'p-1', 'slug' => '/', '_funnel' => 'F9'];
$p = dot_click_payload($req, ['hit_id' => 42, 'domain_id' => 'd-1', 'outcome' => 'served', 'status' => 200, 'route' => $route, 'visit_id' => str_repeat('a', 32), 'asn' => 7922, 'as_name' => 'COMCAST', 'hostname' => 'c-1.comcast.net'], $dotServer);
same('event', 'click', $p['event']);
same('site = the host, lander = the path', ['shop.example', '/'], [$p['site'], $p['lander']]);
same('url = the whole URL', 'https://shop.example' . $uri, $p['url']);
same('referrer, ip, user agent', ['https://www.tiktok.com/', '203.0.113.9', $dotServer['HTTP_USER_AGENT']], [$p['referrer'], $p['ip'], $p['user_agent']]);
same('cid = cmpid, rtkcid', ['67126e08', '6a97'], [$p['cid'], $p['rtkcid']]);
same('sub1…sub11 as they came (dot maps them)', ['[TT 50] [F9] [CBO]', 'Ad group 2', 'ad.mp4', '111', '222', '333', 'TikTok', 'TikTok'], [$p['sub1'], $p['sub2'], $p['sub3'], $p['sub4'], $p['sub5'], $p['sub6'], $p['sub10'], $p['sub11']]);
check('absent subs are left out', !array_key_exists('sub7', $p) && !array_key_exists('sub9', $p));
same('ext_click_id = the click id', 'E_C_P_abc', $p['ext_click_id']);
same('the visitor\'s dotid (dot.js cookie)', 'aebe26bd-d0245268-71fa28c5-09252103', $p['dotid']);
same('timestamp = when the click came (UTC)', gmdate('Y-m-d\\TH:i:s', 1790000000) . '.250Z', $p['timestamp']);
$meta = json_decode($p['_metadata'], true);
same('metadata: the headers, lowercase, without cookie/authorization', ['accept' => 'text/html', 'cf-ray' => 'abc-EWR', 'cf-region' => 'Texas', 'host' => 'shop.example', 'user-agent' => $dotServer['HTTP_USER_AGENT']], $meta['headers']);
same('metadata: the cookies apart', $dotServer['HTTP_COOKIE'], $meta['cookies']);
same('metadata: the click ids', ['ttclid' => 'E_C_P_abc'], $meta['click_ids']);
same('metadata: what this server did', ['hit_id' => 42, 'decision' => 'SERVE · GATE', 'sent_to_funnel' => true, 'funnel' => 'F9', 'page_id' => 'p-1', 'country' => 'US', 'region' => 'Texas', 'device' => 'mobile', 'asn' => 7922, 'as_name' => 'COMCAST'],
    array_intersect_key($meta['dayone_pages'], array_flip(['hit_id', 'sent_to_funnel', 'funnel', 'decision', 'page_id', 'country', 'region', 'device', 'asn', 'as_name'])));

// The funnel page and the VSL video: fields of their own (dot's video_id column) and in the metadata.
same('page_id: the funnel page the gate served', 'p-1', $p['page_id']);
check('no video drawn: no video_id', !array_key_exists('video_id', $p) && $meta['dayone_pages']['video_id'] === null);
$pv = dot_click_payload($req, ['route' => $route + ['_video' => str_repeat('b', 24)]], $dotServer);
same('video_id: the video this response drew', [str_repeat('b', 24), str_repeat('b', 24)], [$pv['video_id'], json_decode($pv['_metadata'], true)['dayone_pages']['video_id']]);
$ps = dot_click_payload($dotReq('/?fbclid=F1'), ['route' => ['action' => 'SERVE', 'match_type' => 'GATE-SAFE', 'page_id' => 'safe-1']], []);
check('the safe page: no page_id field (not a funnel page), it stays in the metadata', !array_key_exists('page_id', $ps) && json_decode($ps['_metadata'], true)['dayone_pages']['page_id'] === 'safe-1');

// A click a rule caught (the safe page): sent too, with the rule.
$safe = ['action' => 'SERVE', 'match_type' => 'GATE-SAFE', '_rule_label' => 'Bot', '_rule' => 'DC', '_rule_reason' => 'Datacenter', '_rule_tags' => ['FB']];
$m = json_decode(dot_click_payload($dotReq('/?fbclid=F1'), ['route' => $safe], [])['_metadata'], true)['dayone_pages'];
same('a click a rule caught: sent, with the rule', [false, 'Bot', 'DC', 'Datacenter', ['FB']], [$m['sent_to_funnel'], $m['rule_label'], $m['rule'], $m['rule_reason'], $m['rule_tags']]);

// ── A pre-lander (a slug outside the home + the legal pages): a real click gets a server-side page_view ──
// The click event itself is unchanged — no origin, on any slug.
check('the click event keeps no origin on a pre-lander slug', !array_key_exists('origin', dot_click_payload($dotReq('/pre?gclid=G9'), ['status' => 200, 'route' => ['match_type' => 'GATE-SAFE']], [])));

// dot_pre_lander_origin: served 200 + a non-standard slug + no rule caught it (and not a funnel page the gate served).
$gateSafe = ['match_type' => 'GATE-SAFE'];
same('pre_lander: a non-standard slug served 200, clean', 'pre_lander', dot_pre_lander_origin('/pre', 200, $gateSafe));
same('pre_lander: not for the home', null, dot_pre_lander_origin('/', 200, $gateSafe));
same('pre_lander: not for a legal page', null, dot_pre_lander_origin('/privacy-policy', 200, $gateSafe));
same('pre_lander: only on served 200 (not 304/404)', [null, null], [dot_pre_lander_origin('/pre', 304, $gateSafe), dot_pre_lander_origin('/pre', 404, $gateSafe)]);
same('pre_lander: not a funnel page the gate served (it has dot.js)', null, dot_pre_lander_origin('/pre', 200, ['match_type' => GATE_MATCH]));
same('pre_lander: not when a rule caught it (datacenter, crawler…)', null, dot_pre_lander_origin('/pre', 200, $gateSafe + ['_rule_label' => 'Bot']));

// dot_page_view: the click's own fields, as event page_view, marked origin pre_lander (the click is left as it was).
$pvFrom = dot_page_view(['event' => 'click', 'site' => 's', 'ext_click_id' => 'G9'], 'pre_lander');
same('page_view: the click fields, event page_view, origin pre_lander', ['page_view', 'pre_lander', 's', 'G9'], [$pvFrom['event'], $pvFrom['origin'], $pvFrom['site'], $pvFrom['ext_click_id']]);
same('gclid + wbraid: ext_click_id is gclid, wbraid goes too', ['G1', 'W1'], array_values(array_intersect_key(dot_click_payload($dotReq('/?wbraid=W1&gclid=G1'), [], []), array_flip(['ext_click_id', 'wbraid']))));
same('?dotid= wins over the cookie', '11111111-22222222-33333333-09252103', dot_click_payload($dotReq('/?fbclid=x&dotid=11111111-22222222-33333333-09252103', ['HTTP_COOKIE' => 'dotid=aebe26bd-d0245268-71fa28c5-09252103']), [], [])['dotid']);
check('a malformed dotid is dropped (dot makes one)', !array_key_exists('dotid', dot_click_payload($dotReq('/?fbclid=x', ['HTTP_COOKIE' => 'dotid=<script>']), [], [])));
same('http when Cloudflare says the visitor came by http', 'http://shop.example/?fbclid=x', dot_click_payload($dotReq('/?fbclid=x'), [], ['HTTP_CF_VISITOR' => '{"scheme":"http"}'])['url']);
check('config: on by default, the real endpoint', config()['dot_url'] === 'https://cdn.dayone.click/functions/v1/dot');
check('the tests run with DOT_CLICKS=0 (never the real tracker)', config()['dot_clicks'] === false);
check('config: the timeout is above dot\'s own 4 s for its database write', config()['dot_timeout'] === 8);

// What dot's answer means: queued, worth another try (no answer, a 5xx), or a failure that won't get better.
same('200 + success: queued', ['ok' => true, 'retry' => false, 'why' => ''], dot_outcome(200, '{"success":true,"queued":true,"msg_id":1}'));
same('no answer (curl gave up): try again, with curl\'s reason', ['ok' => false, 'retry' => true, 'why' => 'HTTP 0: Operation timed out after 8001 milliseconds'], dot_outcome(0, false, 'Operation timed out after 8001 milliseconds'));
same('dot\'s 503 (its database write failed): try again', [false, true], array_values(array_slice(dot_outcome(503, "{\"success\":false,\n\"stage\":\"dot_checkpoint\"}"), 0, 2)));
same('the answer goes to the log on one line, cut at 200 characters', 'HTTP 503: {"success":false, "stage":"dot_checkpoint"}', dot_outcome(503, "{\"success\":false,\n\"stage\":\"dot_checkpoint\"}")['why']);
check('a gateway 502/504: try again', dot_outcome(502, '<html>Bad Gateway</html>')['retry'] && dot_outcome(504, '')['retry']);
check('a 4xx: not again', dot_outcome(400, 'bad')['retry'] === false);
check('200 with success false (dot couldn\'t read it): not again', dot_outcome(200, '{"success":false,"stage":"parse"}') === ['ok' => false, 'retry' => false, 'why' => 'HTTP 200: {"success":false,"stage":"parse"}']);
check('200 that isn\'t JSON: not queued', dot_outcome(200, '<html>')['ok'] === false);

// dot_deliver: a click dot didn't queue is sent again 1 s and 4 s later; only the last failure is reported.
$dotWaits = [];
$dotSleep = static function (int $s) use (&$dotWaits) { $dotWaits[] = $s; };
$dotAnswers = static function (array $answers) {
    return static function () use (&$answers) { return array_shift($answers); };
};
$busy = ['ok' => false, 'retry' => true, 'why' => 'HTTP 503: busy'];
$queued = ['ok' => true, 'retry' => false, 'why' => ''];
same('queued at once: nothing to report, no wait', [null, []], [dot_deliver($dotAnswers([$queued]), $dotSleep), $dotWaits]);
same('queued on the 2nd try: nothing to report, waited 1 s', [null, [1]], [dot_deliver($dotAnswers([$busy, $queued]), $dotSleep), $dotWaits]);
$dotWaits = [];
same('never queued: gives up after 3 tries (1 s, 4 s) and reports the last (worth sending later)', [['tries' => 3, 'why' => 'HTTP 0: timeout', 'retry' => true], [1, 4]],
    [dot_deliver($dotAnswers([$busy, $busy, ['ok' => false, 'retry' => true, 'why' => 'HTTP 0: timeout']]), $dotSleep), $dotWaits]);
$dotWaits = [];
same('a failure that won\'t get better: reported at once, no retry (not spooled)', [['tries' => 1, 'why' => 'HTTP 400: bad', 'retry' => false], []],
    [dot_deliver($dotAnswers([['ok' => false, 'retry' => false, 'why' => 'HTTP 400: bad'], $queued]), $dotSleep), $dotWaits]);

// ── The spool: a click dot didn't take goes again later ──
@unlink(dot_spool_path());
@unlink(cache_dir() . '/dot-spool.replay');
$t0 = 1_900_000_000;
check('spool: keeps a click', dot_spool('{"event":"click","ext_click_id":"a"}', $t0) && dot_spool('{"event":"click","ext_click_id":"b"}', $t0) && dot_spool('{"event":"click","ext_click_id":"c"}', $t0));
$seen = [];
$r = dot_spool_replay(function (string $body) use (&$seen): array {
    $seen[] = json_decode($body, true)['ext_click_id'];
    return $body === '{"event":"click","ext_click_id":"b"}' ? ['ok' => false, 'retry' => true, 'why' => 'HTTP 503'] : ['ok' => true, 'retry' => false, 'why' => ''];
}, $t0 + 120);
same('replay: sends in order, stops at the first one dot still can\'t take (it\'s down), keeps the rest', [['a', 'b'], ['sent' => 1, 'kept' => 2, 'dropped' => 0]], [$seen, $r]);
same('replay: not again within a minute', null, dot_spool_replay(fn () => ['ok' => true, 'retry' => false, 'why' => ''], $t0 + 150));
$r = dot_spool_replay(fn (string $body) => str_contains($body, '"c"') ? ['ok' => false, 'retry' => false, 'why' => 'HTTP 400'] : ['ok' => true, 'retry' => false, 'why' => ''], $t0 + 200);
same('replay: a click refused for good (4xx) is given up; the rest go', ['sent' => 1, 'kept' => 0, 'dropped' => 1], $r);
same('replay: an empty spool has nothing to do', null, dot_spool_replay(fn () => ['ok' => true, 'retry' => false, 'why' => ''], $t0 + 400));
dot_spool('{"event":"click","ext_click_id":"old"}', $t0);
$r = dot_spool_replay(fn () => ['ok' => true, 'retry' => false, 'why' => ''], $t0 + DOT_SPOOL_MAX_AGE + 500);
same('replay: a click over a day old is given up, not sent', ['sent' => 0, 'kept' => 0, 'dropped' => 1], $r);
same('deliver: the last failure says whether it is worth sending later', ['tries' => 3, 'why' => 'HTTP 503: x', 'retry' => true], dot_deliver(fn () => dot_outcome(503, 'x'), fn () => null));
@unlink(dot_spool_path());
@unlink(cache_dir() . '/dot-spool.replay');
