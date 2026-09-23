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
condições (país, dispositivo, idioma, parâmetros de URL, referrer) casam
decide: servir uma slug, redirecionar ou bloquear. `bot` só é honrado em
rotas de bloqueio.

### Funil em modo servidor (`dop_step`)

Uma slug com sub-páginas (presell → principal → back redirect, ver README da
raiz) pode ser gravada com `<body data-dop-funnel="server">`. Aí o HTML da
slug vai para o cache como está (todas as seções), mas **na resposta** o
servidor (`src/funnel.php`) entrega só a etapa atual:

- etapa = cookie `dop_step=<id>` se apontar para uma seção que existe; senão
  a inicial (`data-dop-start`);
- as outras `<section data-dop-page>` são removidas do HTML; a servida perde o
  `hidden`; o `<body>` recebe `data-dop-cur/-next/-start/-main/-br/-br-trigger`
  para o runtime da página saber para onde ir;
- o runtime avança gravando `dop_step` (`Path` = o path da slug, 1 dia) e
  recarregando a mesma URL. A URL nunca muda e o fonte de uma etapa não
  contém as outras.

O `ETag` vira `"<hash>-<etapa>"` e a resposta leva `Vary: Cookie`. O HTML
sempre vem da origem (o Cloudflare não cacheia HTML por padrão); se um dia
ligar cache de HTML, funil em modo servidor exige *Bypass* nessa slug.
Sem o atributo (modo navegador), nada disso roda e o HTML sai inteiro.

O corte é por contagem de `<section>` numa cópia do HTML com comentários,
`<script>`, `<style>` e `<template>` apagados (mesmo tamanho), então um
`</section>` dentro deles não conta. Se mesmo assim o servidor reconhecer
menos de duas etapas numa slug em modo servidor, ele serve o HTML inteiro e
registra no log (`funil em modo servidor com N etapa(s)`) — a página continua
funcionando, no modo navegador.

**Ordem de deploy:** o servidor PHP antes do dashboard, para uma slug salva
em modo servidor já ser cortada por etapa desde a primeira visita.

### Entrada por `www.` (`sub0`)

Uma página que seria servida em `www.x.com` vira um **302** para o domínio sem
www, com os parâmetros originais. Se a URL traz campanha — `sub1`,
`utm_campaign` ou `campaign`, com valor — ganha também `sub0` = unix timestamp
cifrado (`src/sub0.php`):

```
GET https://www.x.com/oferta?utm_campaign=c1
→ 302 Location: https://x.com/oferta?utm_campaign=c1&sub0=<token>   (Cache-Control: no-store)
GET https://www.x.com/oferta?utm_source=fb&sub1=a&sub2=b
→ 302 Location: https://x.com/oferta?utm_source=fb&sub0=<token>&sub1=a&sub2=b   (sub0 logo antes do sub1)
GET https://www.x.com/oferta?utm_source=fb
→ 302 Location: https://x.com/oferta?utm_source=fb                  (sem campanha, sem sub0)
```

- Só páginas servidas (200/304). Bloqueio, bot, 404, redirect de rota e
  arquivos (`.js`, `robots.txt`…) seguem normais no próprio www.
- O `sub0` entra logo antes do primeiro `sub1`; sem `sub1`, no fim da query.
- Com campanha, um `sub0` que já venha na URL é trocado pelo novo; sem
  campanha a query segue intacta. O hop é registrado nos Logs como
  `redirect` com decisão `REDIRECT · WWW`.
- O vhost do nginx NÃO pode redirecionar `www` por conta própria (bloco
  `server_name ~^www\.…; return 301`): isso responde antes do PHP e o sub0
  nunca sai.
- Token: `base64url(nonce 12 B ‖ cifrado ‖ tag 16 B)`, AES-256-GCM, chave
  `SHA-256(SUB0_KEY)` (padrão `DAYONE`); texto claro = segundos, ex.
  `1790000000`. 51 caracteres. Para decifrar em PHP: `sub0_decrypt($token, 'DAYONE')`;
  em Node:

```js
const b = Buffer.from(token, "base64url");
const d = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update("DAYONE").digest(), b.subarray(0, 12));
d.setAuthTag(b.subarray(-16));
const ts = Number(d.update(b.subarray(12, -16), undefined, "utf8") + d.final("utf8"));
```

## Instalação (Ubuntu/Debian)

> **Só para um VPS limpo e dedicado.** Os arquivos de `deploy/` assumem que esta
> máquina não hospeda mais nada. **Não os aplique num servidor com painel
> (CloudPanel, Plesk, cPanel) nem num que já responda por domínios em produção:**
>
> - `deploy/nginx/dayone-pages.conf` declara `default_server` na porta 80. Se já
>   existir um, o nginx recusa recarregar; se não existir, este passa a responder
>   por TODO domínio apontado para o IP, e os que não estiverem cadastrados no
>   painel viram 404.
> - `deploy/cloudflare-allowlist.sh` fecha a porta 80 para tudo que não for
>   Cloudflare. Domínio com registro `A` direto para o IP sai do ar.
> - O roteiro abaixo apaga `sites-enabled/default`.
>
> Num servidor com painel, crie o site pelo painel e adapte só o vhost dele.


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
