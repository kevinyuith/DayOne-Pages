/**
 * Primeiros 64 bits de um IPv6, ex.: "2804:38a:a16c:afe0". Ficam iguais para a
 * mesma conexão (casa, celular) mesmo quando o final muda por privacidade.
 * IPv4 ou endereço inválido → null.
 */
export function ipv6Prefix64(ip: string | null): string | null {
  if (!ip || !ip.includes(":") || ip.includes(".")) return null;
  const parts = ip.toLowerCase().split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const groups = parts.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":");
}
