# DayOne Pages — servidor de entrega

Um front controller PHP que responde por **qualquer domínio** apontado para
esta máquina: consulta no Supabase (schema `pages`) o que aquele host + path
deve responder, cacheia em disco por 5 minutos e serve. Se o Supabase cair,
serve a cópia que tem.

Sem framework, sem composer. Requisitos: PHP 8.2+ com `curl` e `json`.

## Como funciona

```
Cloudflare ──HTTP:80──► nginx (catch-all) ──► php-fpm ──► public/index.php
                                                              │
                                             cache/routes/<host>/<path>.json  (rotas, TTL 300 s)
                                             cache/content/<slug>-<hash>.bin  (HTML por slug)
                                                              │ MISS
                                             POST {SUPABASE_URL}/rest/v1/rpc/resolve  (Content-Profile: pages)
```

| Situação | Resposta | `X-Cache` |
|---|---|---|
| cache fresco | serve | `HIT` |
| cache expirado ou ausente, Supabase ok | consulta, regrava, serve | `MISS` |
| Supabase fora, há cópia expirada | serve a cópia (até `STALE_MAX_AGE`) | `STALE` |
| Supabase fora, sem cópia | 503 + `Retry-After` | — |
| outro worker atualizando | serve a cópia expirada | `UPDATING` |
| domínio desconhecido | 404 (cache negativo `NEGATIVE_TTL`) | `MISS`/`HIT` |

As rotas do domínio são avaliadas em ordem de prioridade; a primeira cujas
condições (país, dispositivo, parâmetros de URL, referrer) casam decide:
servir uma slug, redirecionar ou bloquear. `bot` só é honrado em rotas de
bloqueio.

## Instalação (Ubuntu/Debian)

```bash
apt install -y nginx php8.3-fpm php8.3-curl
mkdir -p /var/www/dayone-pages /var/cache/dayone-pages /var/log/php
cp -r server /var/www/dayone-pages/
chown -R www-data:www-data /var/cache/dayone-pages /var/log/php

cp server/.env.example /var/www/dayone-pages/server/.env   # preencha
chown root:www-data /var/www/dayone-pages/server/.env && chmod 640 /var/www/dayone-pages/server/.env
cp server/deploy/php-fpm/dayone-pages.conf /etc/php/8.3/fpm/pool.d/
cp server/deploy/nginx/dayone-pages.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/dayone-pages.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

systemctl restart php8.3-fpm
bash server/deploy/cloudflare-allowlist.sh   # firewall só para o Cloudflare + real_ip; recarrega o nginx
curl -si http://127.0.0.1/_health                # 200 + X-DayOne-Pages
```

**Antes de rodar o `cloudflare-allowlist.sh`:** ele liga o `ufw`. O script libera
a porta do SSH (lida do `sshd -T`) antes de ligar, mas mantenha uma segunda
sessão SSH aberta e saiba onde fica o console de emergência do seu provedor.
Depois de rodar, abra uma sessão SSH NOVA para confirmar que entra, e só então
feche a antiga. O script foi testado contra um `ufw` simulado, não num Ubuntu
real: confira o resultado com `ufw status` na primeira vez.

Cron sugerido (root):

```
0 4 * * 0  bash /var/www/dayone-pages/server/deploy/cloudflare-allowlist.sh
0 5 * * *  find /var/cache/dayone-pages -type f -mtime +7 -delete
```

## Chave do servidor

O servidor não recebe a chave de serviço do Supabase. Ele chama a função
`pages.resolve(host, path, key)` com a chave publicável mais uma chave própria.

```bash
openssl rand -hex 32        # → PAGES_SERVER_KEY no server/.env
```

E no SQL Editor do projeto:

```sql
INSERT INTO pages.server_keys (name, key_hash)
VALUES ('origin-1', encode(sha256(convert_to('<a chave gerada>', 'UTF8')), 'hex'));
```

Para revogar: `UPDATE pages.server_keys SET revoked_at = now() WHERE name = 'origin-1';`

## Cloudflare (por domínio)

- DNS: `A @ → IP do servidor` (proxy ligado) e `CNAME www → @` (proxy ligado).
- SSL/TLS: **Flexible** (a origem é só HTTP). *Always Use HTTPS* ligado.
- Speed: desligar *Auto Minify* e *Rocket Loader* (reescrevem o HTML e quebram o ETag).
- WAF/Bot Fight Mode: liberar `/_health` (o dashboard consulta para verificar o domínio).

## Endpoints internos

- `GET /_health` → `{"ok":true,"server_id":...,"cache_writable":true}` com header `X-DayOne-Pages: <SERVER_ID>`. Não depende do Supabase.
- `POST /_purge` com `X-Purge-Token: <PURGE_TOKEN>` e corpo `{"host":"exemplo.com"}` ou `{"all":true}`. Token ausente/errado → 404.

## Teste local

```bash
php server/tests/run.php                              # unidades: normalização, condições, cache
cp server/.env.example server/.env                    # preencha SUPABASE_URL, SUPABASE_ANON_KEY, PAGES_SERVER_KEY, SERVER_ID
CACHE_DIR=/tmp/dayone-cache php -S 127.0.0.1:8080 -t server/public server/public/index.php

H='Host: exemplo.com'
curl -si -H "$H" localhost:8080/ | grep -E 'HTTP|X-Cache|ETag'      # MISS
curl -si -H "$H" localhost:8080/ | grep X-Cache                      # HIT
curl -si -H 'Host: nope.example' localhost:8080/ | head -1           # 404
curl -si localhost:8080/_health | grep X-DayOne-Pages
```

`php -S` não tem `fastcgi_finish_request`; SWR só age no php-fpm.
