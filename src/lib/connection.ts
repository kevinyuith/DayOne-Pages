export type ConnectionType = "Mobile" | "Fixed (WiFi/cable)" | "Datacenter/VPN";

// Nuvem, hospedagem, CDN/relay e redes de VPN. Conferidos na Team Cymru em 22/09/2026.
const DATACENTER = new Set([
  16509, 14618, 8987, // Amazon
  396982, 15169, 19527, // Google
  8075, 8068, // Microsoft
  31898, 792, // Oracle
  14061, // DigitalOcean
  63949, 20940, 16625, 36183, // Akamai/Linode (36183 = iCloud Private Relay)
  16276, // OVH
  24940, 213230, // Hetzner
  20473, // Vultr
  51167, // Contabo
  12876, // Scaleway
  45102, 37963, // Alibaba
  132203, 45090, // Tencent
  136907, // Huawei Cloud
  13335, // Cloudflare (WARP)
  54113, // Fastly
  9009, // M247
  48090, // DMZHOST
  60781, 16265, 28753, // Leaseweb
  60068, // CDN77/Datacamp
  62044, 53813, // Zscaler
  396986, // ByteDance
  32934, // Facebook
  6939, // Hurricane Electric
  40676, // Psychz
  36352, // ColoCrossing/HostPapa
  47583, // Hostinger
  26496, // GoDaddy
  8560, // IONOS
  22612, // Namecheap
]);

// Operadoras móveis. Vivo (26599) e TIM (26615) também têm rede fixa no mesmo ASN.
const MOBILE = new Set([
  22085, // Claro S/A (móvel)
  26615, // TIM
  26599, // Vivo
  21928, // T-Mobile US
  6167, 22394, // Verizon Wireless
  20057, // AT&T Mobility
  10507, // Sprint
]);

// Fixas conhecidas, para o nome não enganar as regras abaixo (ex.: Google Fiber).
const FIXED = new Set([
  28573, // Claro NXT (NET/Virtua)
  4230, // Claro/Embratel
  18881, 27699, // Vivo fixa
  7738, 8167, // V.tal (Oi)
  16591, // Google Fiber
  7018, // AT&T Internet
]);

/**
 * Tipo de conexão ESTIMADO pelo ASN. O servidor não enxerga WiFi x cabo: "Fixa"
 * é rede de casa/empresa. VPN residencial e ASN que mistura fixa e móvel
 * escapam. Sem ASN → null.
 */
export function connectionType(asn: number | null, asName: string | null): ConnectionType | null {
  if (!asn) return null;
  if (DATACENTER.has(asn)) return "Datacenter/VPN";
  if (MOBILE.has(asn)) return "Mobile";
  if (FIXED.has(asn)) return "Fixed (WiFi/cable)";
  const name = asName ?? "";
  if (/hosting|cloud|data ?cent|server|\bvps\b|\bcolo/i.test(name)) return "Datacenter/VPN";
  if (/mobil|wireless|cellular|cellco|celular|m[oó]vil|m[oó]vel/i.test(name)) return "Mobile";
  return "Fixed (WiFi/cable)";
}
