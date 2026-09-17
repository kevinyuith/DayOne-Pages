#!/usr/bin/env bash
# Só o Cloudflare pode falar com a porta 80 desta máquina.
#
# Sem isto, qualquer um bate direto no IP, pula o Cloudflare e FORJA os headers
# CF-IPCountry / CF-Connecting-IP — e as rotas por país passam a valer nada.
# Também gera o include do nginx com set_real_ip_from.
#
# Uso (root): ./cloudflare-allowlist.sh   — rode de novo semanalmente (cron).
set -euo pipefail

V4=$(curl -fsS https://www.cloudflare.com/ips-v4)
V6=$(curl -fsS https://www.cloudflare.com/ips-v6)

# nginx real_ip
{
  echo "# gerado por cloudflare-allowlist.sh em $(date -u +%FT%TZ)"
  for ip in $V4 $V6; do echo "set_real_ip_from $ip;"; done
} > /etc/nginx/cloudflare-real-ip.conf

# ufw: fecha 80 para todo mundo e abre só para o Cloudflare.
if command -v ufw >/dev/null; then
  ufw --force delete allow 80/tcp >/dev/null 2>&1 || true
  # Remove regras antigas do Cloudflare (marcadas por comentário).
  ufw status numbered | grep -i 'cloudflare' | awk -F'[][]' '{print $2}' | sort -rn | while read -r n; do
    ufw --force delete "$n" >/dev/null 2>&1 || true
  done
  for ip in $V4 $V6; do
    ufw allow from "$ip" to any port 80 proto tcp comment 'cloudflare' >/dev/null
  done
  ufw --force enable >/dev/null
  echo "ufw: porta 80 aberta só para $(echo "$V4 $V6" | wc -w | tr -d ' ') faixas do Cloudflare"
else
  echo "ufw não encontrado: aplique as faixas no seu firewall (nftables/iptables/cloud)." >&2
fi

nginx -t && systemctl reload nginx
