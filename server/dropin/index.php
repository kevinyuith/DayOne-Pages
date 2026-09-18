<?php
/**
 * DayOne Pages — ponto de entrada (versão "soltar na pasta do site").
 *
 * O nginx tem de mandar TODO caminho para este arquivo. Ele descobre o domínio
 * e o path pedidos, consulta o Supabase (com cache de 5 minutos em _cache/) e
 * devolve a página. Configure em config.php; não edite _dayone/.
 */
declare(strict_types=1);

define('DAYONE_ENTRY', true);

require __DIR__ . '/_dayone/bootstrap.php';

dayone_handle();
