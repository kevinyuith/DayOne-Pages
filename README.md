# DayOne Pages

A intenção principal do produto é ser um **editor de páginas**: você monta a
página uma vez, publica em quantos domínios quiser e usa o mesmo painel para
fazer **teste A/B** entre versões. No modelo do hidepages.com.

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
equipe    ─► dashboard (Next.js, sem login) ─► server actions ─service key─► Supabase (schema pages)
```

## Tela de páginas: cards e pastas

`/paginas` é uma grade de cards no modelo do hidepages: o card **Criar
página**, as pastas e as páginas da pasta aberta. Pastas podem ter subpastas
(sem limite prático; o banco barra ciclos e mais de 20 níveis), e a pasta
aberta fica na URL (`/paginas?pasta=<id>`), com breadcrumb.

- **Mover**: arraste um card (página ou pasta) para cima de uma pasta ou de
  um item do breadcrumb; ou menu "…" → *Mover para…*. Uma pasta não entra em
  si mesma nem numa subpasta dela.
- **Menu "…"** da página: abrir, renomear, duplicar (cópia como rascunho com
  todas as slugs e o mesmo HTML, com ids novos para as sub-páginas do funil;
  domínios e rotas continuam na original), mover, excluir. Da pasta: renomear, cor, mover, excluir — excluir uma
  pasta não apaga nada: o conteúdo sobe para a pasta-mãe.
- **Busca** atravessa todas as pastas e mostra onde cada resultado está.

No banco: `pages.folders` (`parent_id`, `color`) e `pages.pages.folder_id`
(`supabase/migrations/20260921_folders.sql`). O servidor de entrega não sabe
que pastas existem — é só organização do painel.

## Editor: links, painéis e funil

O editor de slug (`/paginas/[id]/slugs/[slugId]`) tem uma barra de ícones à
esquerda com cinco painéis, no modelo do hidepages:

- **Pages** — as slugs da página (cada uma é uma URL com o próprio HTML).
- **Funil** — as sub-páginas desta slug (ver abaixo): mesma URL, a troca
  acontece no navegador ou no servidor (seletor no painel).
- **Widgets** — Text, Image, Video, Button, Container, HTML. Clique insere
  depois do elemento selecionado (ou no fim da sub-página atual).
- **Layers** — a árvore da sub-página atual; clique seleciona na canvas.
- **Links** — todos os links da página (`<a href>`, `<area>`, `<form action>`
  e os atrelados), agrupados por destino, com a sub-página de cada um. Clique
  seleciona na canvas; **Trocar** muda todas as ocorrências de um destino;
  **Apontar todos** manda todos os links da página para um destino só.

Na canvas, cada link ganha um **marcador** (chip `a` / `form` / `atrelado`);
clicar nele seleciona o elemento. O botão "N links" na barra inferior liga e
desliga os marcadores.

**Atrelar link a qualquer elemento.** No inspetor (Settings), o campo *Link*
edita o `href` de um `<a>` (ou do `<a>` que envolve o elemento). Para um
elemento que não é link (botão, imagem, bloco), o mesmo campo grava
`data-href` (+ `data-target="_blank"` se "Abrir em nova aba"). O seletor
*Destino* oferece as sub-páginas do funil (`#next-step`, `#page:<id>`), as
outras slugs da página e URL livre.

**Funil (sub-páginas na mesma URL).** Uma slug pode conter várias
sub-páginas — presell → principal → back redirect — sem mudar a URL. Elas
ficam no HTML da própria slug, como seções irmãs no body:

```html
<section data-dop-page="p_ab12" data-dop-name="Presell" data-dop-kind="presell" data-dop-start>…</section>
<section data-dop-page="p_cd34" data-dop-name="VSL" data-dop-kind="main" hidden>…</section>
<section data-dop-page="p_ef56" data-dop-name="Volta" data-dop-kind="backredirect" data-dop-trigger="back exit" hidden>…</section>
<script data-dop-runtime>…</script>
```

A **inicial** (`data-dop-start`) é a única sem `hidden` — sem JS, é a que
aparece. A ordem no body é a ordem do funil: `#next-step` avança para a
próxima que não é back redirect. A **back redirect** aparece quando o
visitante aperta voltar (`back`) e/ou leva o mouse para fora da aba (`exit`).
Presells entram antes da inicial; back redirects, no fim. Quando a slug fica
com uma sub-página só, o editor desembrulha e ela volta a ser página única.
O `<head>` (CSS) é compartilhado — páginas clonadas de sites diferentes podem
conflitar; prefira classes com prefixo.

**Runtime.** O `<script data-dop-runtime>` no fim do body só existe enquanto
houver algum `data-href` ou mais de uma sub-página, e some sozinho quando
não precisa mais. Ele delega o clique: `data-href` navega (ctrl/cmd/shift ou
`data-target="_blank"` abrem em nova aba); `#next-step` / `#page:<id>`
trocam a sub-página sem mudar a URL. Na canvas ele não roda (iframe sem
scripts); no Preview e no servidor, roda.

**Dois modos de troca** (seletor "Troca de etapa" no painel Funil, gravado
em `<body data-dop-funnel>`):

| | No navegador (padrão) | No servidor |
|---|---|---|
| O que o visitante recebe | o HTML inteiro, com todas as etapas (`hidden`) | só a etapa atual |
| Como troca | JS mostra/esconde + `history.pushState` | grava o cookie `dop_step=<id>` (Path = a slug) e recarrega a mesma URL |
| Botão voltar | percorre as etapas; na inicial cai na back redirect | cai na back redirect; dali volta à etapa anterior; depois sai |
| Fonte da presell mostra a principal? | sim | não |
| Quem precisa mudar | ninguém (PHP serve como está) | o PHP corta as seções na resposta (`server/src/funnel.php`) |

No modo servidor a URL também não muda, e o servidor responde com `ETag`
por etapa e `Vary: Cookie`; o HTML vem sempre da origem (não ligue cache de
HTML no Cloudflare para essas slugs). Preview e canvas mostram tudo nos dois
modos — o corte só acontece no servidor de entrega.

Os painéis Links, Layers e Funil são derivados do HTML atual (`parseHtml`,
com os mesmos uids que a canvas atribui), então funcionam também no modo
Código: a troca é aplicada no HTML e o editor recarrega a canvas.

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
| `SERVER_ID` | marcador do `/_health`; igual ao `SERVER_ID` do `server/.env` |
| `ORIGIN_URL` | opcional; URL direta do servidor |

**O painel não tem login.** Qualquer pessoa com a URL edita páginas e
domínios. Proteja o deploy na rede: Cloudflare Access na frente do host, ou
allowlist de IP no proxy reverso.

## Banco

Aplique as migrações de `supabase/migrations/` em ordem de nome sobre o
schema `pages` já existente no projeto (SQL Editor); todas são idempotentes.
A mais recente, `20260921_folders.sql`, é obrigatória para a tela de páginas
(sem ela, `/paginas` falha ao carregar as pastas). Depois registre a chave do servidor de
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
