/**
 * Navegador a partir do User-Agent, para exibição: "Chrome 140", "Safari 26",
 * "Instagram (app)", "Googlebot", "curl 8.4". A ordem das regras importa:
 * bots e apps se disfarçam de Chrome/Safari, e Edge/Opera/Samsung trazem
 * "Chrome/" no UA.
 */
export function browserFromUA(ua: string | null): string | null {
  if (!ua) return null;

  const bot = ua.match(/\b([A-Za-z][\w-]*?(?:bot|crawler|spider|externalhit|externalagent))\b/i);
  if (bot) return bot[1];
  const compatible = ua.match(/compatible;\s*([A-Za-z][\w.-]*)(?:\/[\d.]+)?\s*[;)]/);
  if (compatible && !/^MSIE$/i.test(compatible[1])) return compatible[1];

  const apps: [RegExp, string][] = [
    [/FBAN|FBAV|FB_IAB/, "Facebook (app)"],
    [/Instagram/, "Instagram (app)"],
    [/BytedanceWebview|musical_ly|TikTok/i, "TikTok (app)"],
    [/Snapchat/, "Snapchat (app)"],
    [/\bGSA\/\d/, "Google (app)"],
  ];
  for (const [re, name] of apps) if (re.test(ua)) return name;

  const browsers: [RegExp, string][] = [
    [/\bEdg(?:e|A|iOS)?\/(\d+)/, "Edge"],
    [/\bOPR\/(\d+)/, "Opera"],
    [/\bSamsungBrowser\/(\d+)/, "Samsung Internet"],
    [/\bCriOS\/(\d+)/, "Chrome"],
    [/\bFxiOS\/(\d+)/, "Firefox"],
    [/\bFirefox\/(\d+)/, "Firefox"],
    [/\bChrome\/(\d+)/, "Chrome"],
    [/\bVersion\/(\d+)[\d.]*.*\bSafari\//, "Safari"],
  ];
  for (const [re, name] of browsers) {
    const m = ua.match(re);
    if (m) return `${name} ${m[1]}`;
  }

  if (!ua.startsWith("Mozilla/")) {
    const tool = ua.match(/^([\w.-]+)(?:\/(\d+(?:\.\d+)?))?/);
    if (tool) return tool[2] ? `${tool[1]} ${tool[2]}` : tool[1];
  }
  return "Other";
}

const WINDOWS_NT: Record<string, string> = { "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" };

/**
 * Sistema e versão a partir do User-Agent: "iOS 26.6", "Android 14",
 * "Windows 10/11", "macOS". Os navegadores CONGELAM parte disso, e aí a versão
 * não aparece em vez de aparecer errada: macOS vem sempre 10.15.7, Chrome no
 * Android manda "Android 10; K", Windows 11 diz NT 10.0. No iOS 26 o token do
 * sistema ficou em 18.x, mas o Version/ do Safari acompanha o sistema.
 */
export function osFromUA(ua: string | null): string | null {
  if (!ua) return null;

  const apple = ua.match(/\b(iPhone|iPad|iPod)\b.*?\bOS (\d+)[_.](\d+)/);
  if (apple) {
    const name = apple[1] === "iPad" ? "iPadOS" : "iOS";
    const safari = ua.match(/\bVersion\/(\d+)\.(\d+)/);
    if (safari && Number(safari[1]) >= 26) return `${name} ${safari[1]}.${safari[2]}`;
    return `${name} ${apple[2]}.${apple[3]}`;
  }

  const android = ua.match(/\bAndroid (\d+(?:\.\d+)?)(;\s*K\))?/);
  if (android) return android[2] ? "Android" : `Android ${android[1]}`;
  if (/\bAndroid\b/.test(ua)) return "Android";

  const windows = ua.match(/\bWindows NT (\d+\.\d+)/);
  if (windows) return WINDOWS_NT[windows[1]] ? `Windows ${WINDOWS_NT[windows[1]]}` : "Windows";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macOS";
  if (/\bLinux\b/.test(ua)) return "Linux";
  return null;
}
