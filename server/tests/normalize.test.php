<?php
declare(strict_types=1);

// Host: the same cases as pages.normalize_host.
same('host lowercase without port', 'example.com', normalize_host('Example.COM:80'));
same('host without www', 'example.com', normalize_host('www.example.com'));
same('host without trailing dot', 'example.com', normalize_host('example.com.'));
same('host www + port + dot', 'sub.example.com', normalize_host('WWW.Sub.Example.com.:8080'));
same('host empty', '', normalize_host(''));

check('host valid', is_valid_host('example.com'));
check('host valid with hyphen', is_valid_host('my-offer.com.br'));
check('host invalid: ip', !is_valid_host('127.0.0.1'));
check('host invalid: localhost', !is_valid_host('localhost'));
check('host invalid: empty', !is_valid_host(''));
check('host invalid: www', !is_valid_host('www.example.com'));
check('host invalid: uppercase', !is_valid_host('Example.com'));
check('host invalid: slash', !is_valid_host('example.com/x'));

// Path: the same cases as pages.normalize_path.
same('path root', '/', normalize_path('/'));
same('path empty', '/', normalize_path(''));
same('path without query', '/promo', normalize_path('/promo?a=1'));
same('path without fragment', '/promo', normalize_path('/promo#x'));
same('path lowercase', '/promo', normalize_path('/PROMO'));
same('path collapses slashes', '/a/b', normalize_path('//a///b'));
same('path without trailing slash', '/a/b', normalize_path('/a/b/'));
same('path root with slashes', '/', normalize_path('///'));
same('path index with slash and query', '/index', normalize_path('//index/?a=1'));
