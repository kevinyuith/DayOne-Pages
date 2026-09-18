#!/usr/bin/env bash
# Monta a versão "soltar na pasta do site": para hospedagem com painel
# (CloudPanel, Plesk...), onde a pasta do site É o webroot e não dá para pôr
# src/ e .env fora dele.
#
#   index.php      ponto de entrada (único arquivo que o nginx precisa chamar)
#   config.php     configuração (no lugar do .env; nunca é entregue como texto)
#   _dayone/       o código de src/, cada arquivo com trava contra acesso direto
#   _cache/        criado sozinho na primeira visita
#
# A fonte continua sendo server/src/ — esta pasta é GERADA, não editada.
# Uso: bash server/build-dropin.sh [destino]     (padrão: server/dist/dropin)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/dist/dropin}"

rm -rf "$OUT" && mkdir -p "$OUT/_dayone"
cp "$HERE"/src/*.php "$OUT/_dayone/"
cp "$HERE/dropin/index.php" "$OUT/index.php"
cp "$HERE/dropin/config.php" "$OUT/config.php"

# Todo arquivo interno tem de carregar a trava. Sem ela, um pedido direto roda o arquivo.
for f in "$OUT"/_dayone/*.php "$OUT/config.php"; do
  grep -q "defined('DAYONE_ENTRY')" "$f" || { echo "SEM TRAVA: $f" >&2; exit 1; }
done
for f in "$OUT"/index.php "$OUT"/config.php "$OUT"/_dayone/*.php; do php -l "$f" >/dev/null; done
echo "drop-in montado em $OUT"
