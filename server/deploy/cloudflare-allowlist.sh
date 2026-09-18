#!/usr/bin/env bash
# Só o Cloudflare pode falar com a porta 80 desta máquina.
#
# Sem isto, qualquer um bate direto no IP, pula o Cloudflare e FORJA os headers
# CF-IPCountry / CF-Connecting-IP — e as rotas por país passam a valer nada.
# Também gera o include do nginx com set_real_ip_from.
#
# Uso (root): ./cloudflare-allowlist.sh   — rode de novo semanalmente (cron).
#
# DUAS TRAVAS DE SEGURANÇA, as duas nascidas de defeitos da primeira versão:
#
#   1. O SSH é liberado ANTES de qualquer `ufw enable`. Ativar o ufw sem uma
#      regra de SSH aplica o bloqueio padrão de entrada e tranca você do lado
#      de fora de uma máquina que só se acessa por SSH. A porta vem do sshd em
#      execução (`sshd -T`), não de um 22 presumido.
#   2. A lista é sincronizada POR IP, nunca por número de regra: entra o que
#      falta, sai o que sobrou. O ufw ignora regra repetida, então "anotar as
#      antigas, inserir as novas, apagar as antigas" apagaria justamente as
#      que estão valendo numa semana em que a lista não mudou — porta 80
#      fechada para todo mundo. E toda busca tolera não achar nada: com
#      `set -o pipefail`, um `grep` vazio abortava o script no meio.
set -euo pipefail

V4=$(curl -fsS https://www.cloudflare.com/ips-v4)
V6=$(curl -fsS https://www.cloudflare.com/ips-v6)

# Lista vazia = download falhou pela metade. Não mexe em firewall nenhum.
if [ -z "$V4" ] || [ -z "$V6" ]; then
  echo "Lista de IPs do Cloudflare veio vazia. Nada foi alterado." >&2
  exit 1
fi

# nginx real_ip
REAL_IP_CONF="${NGINX_REAL_IP_CONF:-/etc/nginx/cloudflare-real-ip.conf}"
{
  echo "# gerado por cloudflare-allowlist.sh em $(date -u +%FT%TZ)"
  for ip in $V4 $V6; do echo "set_real_ip_from $ip;"; done
} > "$REAL_IP_CONF"

if command -v ufw >/dev/null; then
  # 1. SSH primeiro. Sempre. Mesmo que o ufw já esteja ativo: é idempotente.
  SSH_PORTS=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' || true)
  [ -n "$SSH_PORTS" ] || SSH_PORTS=22
  for port in $SSH_PORTS; do
    ufw allow "$port/tcp" comment 'ssh' >/dev/null
  done
  echo "ufw: SSH liberado na(s) porta(s): $(echo $SSH_PORTS)"

  # 2. O que já existe, por IP. Busca vazia é normal na primeira execução.
  CIDR='([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]+|[0-9a-fA-F:]*:[0-9a-fA-F:]*/[0-9]+'
  CURRENT=$(ufw status | grep -i 'cloudflare' | grep -oE "$CIDR" | sort -u || true)
  DESIRED=$(printf '%s\n' $V4 $V6 | sort -u)

  # 3. Entra o que falta.
  added=0
  for ip in $DESIRED; do
    if ! printf '%s\n' "$CURRENT" | grep -qxF "$ip"; then
      ufw allow from "$ip" to any port 80 proto tcp comment 'cloudflare' >/dev/null
      added=$((added + 1))
    fi
  done

  # 4. Sai o que sobrou — pela ESPECIFICAÇÃO da regra, não pelo número. E sai
  #    a regra aberta da porta 80, se existir. Só depois de as novas entrarem.
  removed=0
  for ip in $CURRENT; do
    if ! printf '%s\n' "$DESIRED" | grep -qxF "$ip"; then
      ufw --force delete allow from "$ip" to any port 80 proto tcp >/dev/null 2>&1 || true
      removed=$((removed + 1))
    fi
  done
  ufw --force delete allow 80/tcp >/dev/null 2>&1 || true
  echo "ufw: $added faixa(s) adicionada(s), $removed removida(s)"

  # 5. Só agora liga, com o SSH já garantido.
  ufw --force enable >/dev/null
  echo "ufw: porta 80 aberta só para $(echo "$V4 $V6" | wc -w | tr -d ' ') faixas do Cloudflare"
else
  echo "ufw não encontrado: aplique as faixas no seu firewall (nftables/iptables/cloud)." >&2
fi

nginx -t && systemctl reload nginx
