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

// A click a rule caught (the safe page): sent too, with the rule.
$safe = ['action' => 'SERVE', 'match_type' => 'GATE-SAFE', '_rule_label' => 'Bot', '_rule' => 'DC', '_rule_reason' => 'Datacenter', '_rule_tags' => ['FB']];
$m = json_decode(dot_click_payload($dotReq('/?fbclid=F1'), ['route' => $safe], [])['_metadata'], true)['dayone_pages'];
same('a click a rule caught: sent, with the rule', [false, 'Bot', 'DC', 'Datacenter', ['FB']], [$m['sent_to_funnel'], $m['rule_label'], $m['rule'], $m['rule_reason'], $m['rule_tags']]);
same('gclid + wbraid: ext_click_id is gclid, wbraid goes too', ['G1', 'W1'], array_values(array_intersect_key(dot_click_payload($dotReq('/?wbraid=W1&gclid=G1'), [], []), array_flip(['ext_click_id', 'wbraid']))));
same('?dotid= wins over the cookie', '11111111-22222222-33333333-09252103', dot_click_payload($dotReq('/?fbclid=x&dotid=11111111-22222222-33333333-09252103', ['HTTP_COOKIE' => 'dotid=aebe26bd-d0245268-71fa28c5-09252103']), [], [])['dotid']);
check('a malformed dotid is dropped (dot makes one)', !array_key_exists('dotid', dot_click_payload($dotReq('/?fbclid=x', ['HTTP_COOKIE' => 'dotid=<script>']), [], [])));
same('http when Cloudflare says the visitor came by http', 'http://shop.example/?fbclid=x', dot_click_payload($dotReq('/?fbclid=x'), [], ['HTTP_CF_VISITOR' => '{"scheme":"http"}'])['url']);
check('config: on by default, the real endpoint', config()['dot_url'] === 'https://cdn.dayone.click/functions/v1/dot');
check('the tests run with DOT_CLICKS=0 (never the real tracker)', config()['dot_clicks'] === false);
