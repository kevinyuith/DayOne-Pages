# DayOne Pages

Administrador de domínios + construtor de páginas, no modelo do hidepages.com.

- **Dashboard** (este repo, Next.js 16): cadastra domínios, cria páginas com
  várias slugs (HTML editado num editor de código com preview) e define, por
  domínio, **rotas**: qual página responde em cada path, com regras por país,
  dispositivo, parâmetros de URL e referrer, além de redirects e bloqueios.
- **Banco**: Supabase, tudo no schema `pages` (`supabase/migrations/`).
- **Servidor de entrega** (`server/`, PHP): responde por qualquer domínio
  apontado para ele, consulta o banco e cacheia em disco por 5 minutos.
  Se o Supabase cair, serve a cópia que tem. Ver [server/README.md](server/README.md).

```
visitante ─► Cloudflare ─HTTP─► nginx + php-fpm (server/) ─► cache 5 min ─► Supabase (pages.resolve)
equipe    ─► dashboard (Next.js) ─senha única─► server actions ─service key─► Supabase (schema pages)
```

## Rodar o dashboard

```bash
cp .env.example .env.local        # preencha (ver abaixo)
npm install
npm run dev                       # http://localhost:3000
```

Variáveis (`.env.local`):

| Variável | O que é |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | chave de serviço (só servidor; atravessa a RLS) |
| `DASH_PASSWORD_HASH` | hash scrypt da senha única: `npm run hash-password` |
| `DASH_SESSION_SECRET` | segredo do cookie de sessão: `openssl rand -hex 32` |
| `SERVER_IP` | IP público do servidor de entrega (instruções de DNS) |
| `SERVER_ID` | marcador do `/_health`; igual ao `SERVER_ID` do `server/.env` |
| `ORIGIN_URL` | opcional; URL direta do servidor |

Login: uma senha única, hash em env, cookie assinado (12 h), 5 tentativas por
IP a cada 15 min. Não há usuários nem cadastro.

## Banco

Aplique `supabase/migrations/20260917_dayone_pages.sql` sobre o schema `pages`
já existente no projeto (SQL Editor). Depois registre a chave do servidor de
entrega em `pages.server_keys` (ver `server/README.md`).

Nunca rode `supabase db push` / `db reset` contra o projeto: o banco é
compartilhado com outros sistemas; este produto só toca o schema `pages`.

## Verificar

```bash
npm run lint && npm run typecheck && npm run build && npm run check:secrets
php server/tests/run.php
```

`check:secrets` procura os valores das variáveis sensíveis dentro de
`.next/static/` depois do build e falha se achar.

## Como o servidor decide o que servir

1. Normaliza host (`WWW.Exemplo.COM:80` → `exemplo.com`) e path (`//Promo/` → `/promo`).
2. Busca no cache `routes/<host>/<path>`; se fresco (< 5 min) e com o HTML em disco, serve.
3. Senão chama `pages.resolve(host, path, chave)`: rotas candidatas em ordem de prioridade + o HTML de cada slug, numa chamada.
4. Percorre as rotas; a primeira cujas condições casam decide: servir a slug, redirecionar ou bloquear. Nenhuma → página padrão do domínio → 404.
5. Supabase fora: serve a cópia expirada (`X-Cache: STALE`) por até 7 dias; sem cópia, 503.

Detecção de bot existe só para **bloquear** (scrapers/crawlers), nunca para
servir conteúdo diferente.
