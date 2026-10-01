<?php
declare(strict_types=1);

// ── supabase.php: the connections stay open between requests (PHP ≥ 8.5) ──

if (function_exists('curl_share_init_persistent')) {
    check('http share: a persistent share (connections, TLS sessions, DNS)', http_share() instanceof CurlSharePersistentHandle);
    check('http share: the same one on every call', http_share() === http_share());
} else {
    same('http share: none before PHP 8.5 (a new connection per call, as before)', null, http_share());
}
check('http curl: a curl handle', http_curl('https://example.com/') instanceof CurlHandle);
