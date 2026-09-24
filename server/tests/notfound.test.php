<?php
declare(strict_types=1);

// O 404 é o "404 Not Found" genérico, igual para path sem página e para bloqueio com 404.
[$status, $headers, $body] = not_found();
same('not_found: 404', 404, $status);
same('not_found: html', 'text/html; charset=utf-8', $headers['Content-Type'] ?? null);
check('not_found: 404 / Not Found / texto', str_contains((string) $body, '<h1>404</h1>') && str_contains((string) $body, '<h2>Not Found</h2>')
    && str_contains((string) $body, 'The resource requested could not be found on this server!'));
check('not_found: sem marca do DayOne', stripos((string) $body, 'dayone') === false);

[$bs, , $bb] = block(['status_code' => 404]);
same('bloqueio 404: status', 404, $bs);
same('bloqueio 404: mesma página do 404', $body, $bb);
[$bs403, , $bb403] = block(['status_code' => 403]);
same('bloqueio 403 continua 403', 403, $bs403);
check('bloqueio 403 não usa a página do 404', !str_contains((string) $bb403, 'Not Found'));
