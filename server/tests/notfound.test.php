<?php
declare(strict_types=1);

// The 404 is the generic "404 Not Found", the same for a path without a page and for a block with 404.
[$status, $headers, $body] = not_found();
same('not_found: 404', 404, $status);
same('not_found: html', 'text/html; charset=utf-8', $headers['Content-Type'] ?? null);
check('not_found: 404 / Not Found / text', str_contains((string) $body, '<h1>404</h1>') && str_contains((string) $body, '<h2>Not Found</h2>')
    && str_contains((string) $body, 'The resource requested could not be found on this server!'));
check('not_found: no DayOne branding', stripos((string) $body, 'dayone') === false);

[$bs, , $bb] = block(['status_code' => 404]);
same('block 404: status', 404, $bs);
same('block 404: same page as the 404', $body, $bb);
[$bs403, , $bb403] = block(['status_code' => 403]);
same('block 403 stays 403', 403, $bs403);
check('block 403 does not use the 404 page', !str_contains((string) $bb403, 'Not Found'));
