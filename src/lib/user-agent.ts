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
  return "Outro";
}
