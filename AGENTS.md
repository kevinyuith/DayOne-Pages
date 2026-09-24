<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Regras do projeto

## Banco de dados (Supabase, schema `pages`)

- **Tudo em inglês**: tabelas, colunas, funções, parâmetros, índices, constraints, valores de CHECK/enum, `COMMENT ON`, mensagens de `RAISE` e os comentários (`--`) dos arquivos de migration e dos corpos de função. Português fica na UI e nos comentários do código TS/PHP. Quando um erro do banco chega na tela, a action traduz pelo código do erro (ex.: `23514`) em vez de mostrar a mensagem crua.
- **Horário em UTC**: toda data é `timestamptz` (nunca `timestamp` sem fuso) e o banco roda em UTC. As funções recebem e devolvem instantes e não convertem fuso: nada de `AT TIME ZONE` nem fuso fixo no SQL. Agrupar por dia local é trabalho do frontend.

## Páginas: templates e páginas do domínio

- **`pages.pages` / `pages.page_slugs` guardam só templates** (a tela "Templates de página", `/paginas`). Template nunca é servido.
- **Tudo o que um domínio serve mora na linha dele, em `pages.domains.site`** (jsonb): as páginas do domínio, cada uma com as slugs e o HTML. Elas nascem como cópia de um template (`domain_page_copy`), e daí em diante são independentes: editar a cópia não muda o template, e editar o template não muda as cópias. "Trocar template" substitui a cópia (`domain_page_replace`, mesmo id, edições perdidas).
- `default_page_id`, `filter_pass_page_id`, `filter_fail_page_id` e `domain_routes.page_id` apontam para chaves de `site`; triggers barram página de outro domínio. Sem FK.
- Escrever em `site` só pelas funções `pages.domain_page_*` / `pages.domain_slug_*` (travam a linha e mudam uma página ou slug por vez, com concorrência por `updated_at`). Ler sem HTML por `pages.domain_pages_summary`; nunca `select("*")` em `domains` (traria o HTML de todas as páginas).
- O editor é um só (`PageEditor`), com as ações e os links vindos da rota: template em `/paginas/[id]/slugs/[slugId]`, página do domínio em `/dominios/[id]/paginas/[pageId]?slug=/caminho`.

## Variação do template

- Ao copiar um template para o domínio dá para pedir uma **variação visual** (`src/lib/pages/variation.ts`): cores, fontes, cantos/sombras e espaçamentos mudam a partir de uma semente, só nos valores de `<style>`/`style=""`/cores de SVG — nunca em seletores, `@font-face`, imagens ou CSS externo (este só ganha a fonte do corpo por cima). Preview antes de gravar (`previewTemplateVariation` → `copyTemplateVariation` → `pages.domain_page_add`).
- Com um **ângulo de copy** informado, os textos são reescritos por IA (`src/lib/pages/copy-angle.ts`): o Kimi (API da Moonshot compatível com a da OpenAI, modo JSON) quando a chave dele está no sistema; senão o Claude (`@anthropic-ai/sdk`, `claude-opus-5`, streaming, saída estruturada, `fallbacks: "default"`) quando há `ANTHROPIC_API_KEY`. **A chave do Kimi fica no sistema, não em `.env`**: criptografada no Supabase Vault via `pages.ai_secret_set/get/status` (lista fechada de nomes — o Vault é compartilhado com o dayone-main), modelo em `pages.app_settings` (`ai.model`), editados em Configurações (`src/lib/ai-settings.ts`). Nunca mandar a chave ao navegador (a tela recebe só os 4 últimos caracteres). Só o texto entre as tags vai para o modelo e volta no mesmo lugar; trecho que perde um `{{marcador}}` fica como estava. O prompt proíbe inventar fatos, promessas, depoimentos e alegações. Sem nenhuma das chaves, só a variação visual funciona. Nenhuma chave vai para o repo (é público).

## Marcadores `{{chave}}`

- Dados da empresa em `pages.domains.placeholders`, com chaves `company.*` (`llc` = razão social, `number`, `address`, `phone`, `email`; lista em `src/lib/pages/placeholders.ts`). `{{company.name}}` não é guardado: é a razão social sem o sufixo jurídico (LLC, Inc., Ltda, GmbH…), por `companyName()` / `company_name()` — mesma lista de sufixos nos dois lados, testada pelos mesmos casos (`server/tests/company-names.json`; `npm run check:company-name` e a suíte PHP). Automáticos, a cada visita: `url`, `domain`, `slug`, `date`, `year`, `lang`, `language` — idioma pelo Accept-Language do visitante (sem ele, `en`), data de hoje em Nova York por extenso nesse idioma.
- Quem troca é o servidor de entrega, ao servir (`server/src/placeholders.php`); o painel faz a mesma troca só no preview (em `en`). As regras e as tabelas de idiomas/meses dos dois lados são iguais — mudou uma, mude a outra: só chave conhecida, valor vazio vira texto vazio, valor escapado em HTML.

## Funil (etapas de uma slug)

- Sempre as mesmas três etapas, nesta ordem: **Pre Lander** (`presell`) → **Lander** (`main`) → **Backredirect**. Não há outros tipos, nomes livres nem etapas extras. Uma slug sem seções é só o Lander.
- Etapa **sem código** (sem seção, ou seção vazia/só comentário) é **inativa** e nunca aparece. O visitante vê primeiro: 1) o Pre Lander, se ativo; 2) senão, o Lander. `#next-step` leva do Pre Lander ao Lander; o Backredirect só aparece pelo voltar/exit intent.
- A regra vale igual em três lugares — mudou um, mude os outros: `src/lib/pages/subpages.ts` (editor), `src/lib/pages/runtime.ts` (modo navegador) e `server/src/funnel.php` (modo servidor, com testes em `server/tests/funnel.test.php`).

## Frontend

- **Fuso de exibição: Nova York** (`America/New_York`), pela constante `APP_TZ` de `src/lib/time-zone.ts`. Todo `Intl.DateTimeFormat`/`toLocale*` que mostra data ou hora passa `timeZone: APP_TZ`; nunca depender do fuso do servidor nem do navegador.
- **NY tem horário de verão**: um dia local tem 23, 24 ou 25 horas. "Meia-noite de N dias atrás" é `localMidnight(now, N)`, nunca `meia-noite - N * 24h`.
