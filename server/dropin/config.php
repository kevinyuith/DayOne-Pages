<?php
/**
 * config.php — the only file you need to edit.
 *
 * It replaces the .env on purpose: nginx never delivers a .php's text, and
 * the line below makes a direct request to /config.php answer 404.
 * Do NOT commit or share it once filled in: it holds keys.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

return [
    // Supabase project. Only the PUBLISHABLE (anon) key — the service key never comes here.
    'SUPABASE_URL'      => 'https://YOUR-PROJECT.supabase.co',
    'SUPABASE_ANON_KEY' => '',

    // This server's key. Its hash must be in pages.server_keys:
    //   INSERT INTO pages.server_keys (name, key_hash)
    //   VALUES ('my-server', encode(sha256(convert_to('<the key>', 'UTF8')), 'hex'));
    'PAGES_SERVER_KEY'  => '',

    // Marker returned by /_health. Same as the panel's SERVER_ID.
    'SERVER_ID'         => '',

    // Token for POST /_purge (X-Purge-Token header). Empty = purge disabled.
    'PURGE_TOKEN'       => '',

    // Disk cache. The folder is created automatically; the site user must be able to write here.
    'CACHE_DIR'         => __DIR__ . '/_cache',
    'CACHE_TTL'         => 60,       // seconds: 1 minute
    'NEGATIVE_TTL'      => 60,       // unknown or paused domain
    'STALE_MAX_AGE'     => 604800,   // how long the expired copy serves if Supabase goes down

    'SUPABASE_TIMEOUT'  => 5,

    // sub0 key: visitors entering via www. go (302) to the domain without www;
    // with sub1/utm_campaign/campaign in the URL, they get ?sub0=<timestamp
    // encrypted with AES-256-GCM>. Without this line it's 'DAYONE'.
    'SUB0_KEY'          => 'DAYONE',
    'DEBUG_HEADERS'     => 1,        // 1 = sends X-Cache (HIT/MISS/STALE). Turn it off after validating.
];
