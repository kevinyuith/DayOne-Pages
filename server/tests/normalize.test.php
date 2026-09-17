<?php
declare(strict_types=1);

// Host: os mesmos casos de pages.normalize_host.
same('host minúsculo sem porta', 'example.com', normalize_host('Example.COM:80'));
same('host sem www', 'example.com', normalize_host('www.example.com'));
same('host sem ponto final', 'example.com', normalize_host('example.com.'));
same('host www + porta + ponto', 'sub.example.com', normalize_host('WWW.Sub.Example.com.:8080'));
same('host vazio', '', normalize_host(''));

check('host válido', is_valid_host('example.com'));
check('host válido com hífen', is_valid_host('minha-oferta.com.br'));
check('host inválido: ip', !is_valid_host('127.0.0.1'));
check('host inválido: localhost', !is_valid_host('localhost'));
check('host inválido: vazio', !is_valid_host(''));
check('host inválido: www', !is_valid_host('www.example.com'));
check('host inválido: maiúscula', !is_valid_host('Example.com'));
check('host inválido: barra', !is_valid_host('example.com/x'));

// Path: os mesmos casos de pages.normalize_path.
same('path raiz', '/', normalize_path('/'));
same('path vazio', '/', normalize_path(''));
same('path sem query', '/promo', normalize_path('/promo?a=1'));
same('path sem fragment', '/promo', normalize_path('/promo#x'));
same('path minúsculo', '/promo', normalize_path('/PROMO'));
same('path colapsa barras', '/a/b', normalize_path('//a///b'));
same('path sem barra final', '/a/b', normalize_path('/a/b/'));
same('path raiz com barras', '/', normalize_path('///'));
same('path index com barra e query', '/index', normalize_path('//index/?a=1'));
