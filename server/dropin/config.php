<?php
/**
 * config.php — único arquivo que você precisa editar.
 *
 * Fica no lugar do .env de propósito: num .php o nginx nunca entrega o texto,
 * e a linha abaixo faz um pedido direto a /config.php responder 404.
 * NÃO versionar nem compartilhar depois de preenchido: tem chaves.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

return [
    // Projeto Supabase. Só a chave PUBLICÁVEL (anon) — a de serviço nunca vem para cá.
    'SUPABASE_URL'      => 'https://SEU-PROJETO.supabase.co',
    'SUPABASE_ANON_KEY' => '',

    // Chave deste servidor. O hash dela tem de estar em pages.server_keys:
    //   INSERT INTO pages.server_keys (name, key_hash)
    //   VALUES ('meu-servidor', encode(sha256(convert_to('<a chave>', 'UTF8')), 'hex'));
    'PAGES_SERVER_KEY'  => '',

    // Marcador devolvido em /_health. Igual ao SERVER_ID do painel.
    'SERVER_ID'         => '',

    // Token do POST /_purge (header X-Purge-Token). Vazio = purge desligado.
    'PURGE_TOKEN'       => '',

    // Cache em disco. A pasta é criada sozinha; o usuário do site precisa poder escrever aqui.
    'CACHE_DIR'         => __DIR__ . '/_cache',
    'CACHE_TTL'         => 300,      // segundos: os "5 minutos"
    'NEGATIVE_TTL'      => 300,      // domínio desconhecido
    'STALE_MAX_AGE'     => 604800,   // por quanto tempo a cópia expirada serve se o Supabase cair

    'SUPABASE_TIMEOUT'  => 5,
    'DEBUG_HEADERS'     => 1,        // 1 = manda X-Cache (HIT/MISS/STALE). Desligue depois de validar.
];
