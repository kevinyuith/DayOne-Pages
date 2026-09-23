<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Regras do projeto

## Banco de dados (Supabase, schema `pages`)

- **Tudo em inglês**: tabelas, colunas, funções, parâmetros, índices, constraints, valores de CHECK/enum, `COMMENT ON`, mensagens de `RAISE` e os comentários (`--`) dos arquivos de migration e dos corpos de função. Português fica na UI e nos comentários do código TS/PHP. Quando um erro do banco chega na tela, a action traduz pelo código do erro (ex.: `23514`) em vez de mostrar a mensagem crua.
- **Horário em UTC**: toda data é `timestamptz` (nunca `timestamp` sem fuso) e o banco roda em UTC. As funções recebem e devolvem instantes e não convertem fuso: nada de `AT TIME ZONE` nem fuso fixo no SQL. Agrupar por dia local é trabalho do frontend.

## Frontend

- **Fuso de exibição: Nova York** (`America/New_York`), pela constante `APP_TZ` de `src/lib/time-zone.ts`. Todo `Intl.DateTimeFormat`/`toLocale*` que mostra data ou hora passa `timeZone: APP_TZ`; nunca depender do fuso do servidor nem do navegador.
- **NY tem horário de verão**: um dia local tem 23, 24 ou 25 horas. "Meia-noite de N dias atrás" é `localMidnight(now, N)`, nunca `meia-noite - N * 24h`.
