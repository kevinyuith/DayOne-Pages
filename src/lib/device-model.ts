/**
 * The phone's model, for the Logs: "iPhone 13", "Galaxy S25 Ultra", "Pixel 8".
 * In order of trust:
 *   1. An Apple identifier in the User-Agent ("iPhone14,5": Facebook's app sends
 *      it as FBDV/, Instagram's in its own token) — exact.
 *   2. The model in Android's User-Agent ("Android 16; SM-S938U Build/…") —
 *      exact, except Chrome, which freezes it to "K"; then the beacon's `mdl`
 *      signal (the Sec-CH-UA-Model client hint, read on the funnel page).
 *   3. An iPhone without either: estimated from the beacon's screen size
 *      (sw×sh @dpr). Display Zoom makes a bigger iPhone read as a smaller one.
 * `code` is what the device sent, when a name was put on it.
 */
export type DeviceModel = { name: string; code: string | null; estimated: boolean };

export function deviceModel(ua: string | null, signals: Record<string, number | string | boolean> | null): DeviceModel | null {
  if (ua) {
    const apple = ua.match(/\b((?:iPhone|iPad|iPod)\d+,\d+)\b/);
    if (apple) return named(APPLE[apple[1]], apple[1]);

    const android = androidModel(ua);
    if (android) return named(samsungName(android), android);
  }

  const hint = typeof signals?.mdl === "string" ? signals.mdl.trim() : "";
  if (hint) return named(samsungName(hint), hint);

  if (ua && /\biPhone\b/.test(ua) && signals) {
    const screen = `${signals.sw}x${signals.sh}@${signals.dpr}`;
    const name = IPHONE_SCREENS[screen];
    if (name) return { name, code: screen.replace("x", "×").replace("@", " @") + "x", estimated: true };
  }
  return null;
}

const named = (name: string | undefined, code: string): DeviceModel => (name ? { name, code, estimated: false } : { name: code, code: null, estimated: false });

/** The model token after "Android N;" in the platform part, without " Build/…"; null when frozen ("K") or missing. */
function androidModel(ua: string): string | null {
  const platform = ua.match(/\(([^()]*\bAndroid\b[^()]*)\)/)?.[1];
  if (!platform) return null;
  const parts = platform.split(";").map((p) => p.trim());
  const at = parts.findIndex((p) => /^Android\b/.test(p));
  for (const part of at < 0 ? [] : parts.slice(at + 1)) {
    const model = part.replace(/\s*\bBuild\/.*$/, "").trim();
    // Skip Chrome's frozen "K", the WebView mark, Firefox's form factor and version, and old UAs' locale ("en-us").
    if (!model || /^(K|wv|Mobile|Tablet|rv:.*|[a-z]{2}[-_][a-z]{2})$/i.test(model)) continue;
    return model;
  }
  return null;
}

/** Samsung's code without the region/carrier suffix ("SM-S938U" → "S938"). */
function samsungName(model: string): string | undefined {
  const m = model.match(/^SM-([A-Z]\d{3})/i);
  return m ? SAMSUNG[m[1].toUpperCase()] : undefined;
}

/** Apple's identifiers (what the device calls itself) → the name it's sold under. */
const APPLE: Record<string, string> = {
  "iPhone8,1": "iPhone 6s",
  "iPhone8,2": "iPhone 6s Plus",
  "iPhone8,4": "iPhone SE",
  "iPhone9,1": "iPhone 7",
  "iPhone9,3": "iPhone 7",
  "iPhone9,2": "iPhone 7 Plus",
  "iPhone9,4": "iPhone 7 Plus",
  "iPhone10,1": "iPhone 8",
  "iPhone10,4": "iPhone 8",
  "iPhone10,2": "iPhone 8 Plus",
  "iPhone10,5": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X",
  "iPhone10,6": "iPhone X",
  "iPhone11,2": "iPhone XS",
  "iPhone11,4": "iPhone XS Max",
  "iPhone11,6": "iPhone XS Max",
  "iPhone11,8": "iPhone XR",
  "iPhone12,1": "iPhone 11",
  "iPhone12,3": "iPhone 11 Pro",
  "iPhone12,5": "iPhone 11 Pro Max",
  "iPhone12,8": "iPhone SE (2nd gen)",
  "iPhone13,1": "iPhone 12 mini",
  "iPhone13,2": "iPhone 12",
  "iPhone13,3": "iPhone 12 Pro",
  "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini",
  "iPhone14,5": "iPhone 13",
  "iPhone14,2": "iPhone 13 Pro",
  "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,6": "iPhone SE (3rd gen)",
  "iPhone14,7": "iPhone 14",
  "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro",
  "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15",
  "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro",
  "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro",
  "iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,3": "iPhone 16",
  "iPhone17,4": "iPhone 16 Plus",
  "iPhone17,5": "iPhone 16e",
  "iPhone18,1": "iPhone 17 Pro",
  "iPhone18,2": "iPhone 17 Pro Max",
  "iPhone18,3": "iPhone 17",
  "iPhone18,4": "iPhone Air",
  "iPhone18,5": "iPhone 17e",
};

/**
 * An iPhone's screen in CSS pixels @ pixel ratio → the iPhones that have it,
 * checked against the Facebook app's exact identifiers on the same hits. The
 * "zoomed" sizes are only ever a bigger iPhone with Display Zoom on.
 */
const IPHONE_SCREENS: Record<string, string> = {
  "320x568@2": "iPhone SE / 5s",
  "375x667@2": "iPhone SE / 6–8",
  "414x736@3": "iPhone 6–8 Plus",
  "375x812@3": "iPhone X / XS / 11 Pro / 12–13 mini",
  "375x812@2": "iPhone XR / 11 (zoomed)",
  "414x896@2": "iPhone XR / 11",
  "414x896@3": "iPhone XS Max / 11 Pro Max",
  "320x693@3": "iPhone 12–17 (zoomed)",
  "390x844@3": "iPhone 12 / 13 / 14 / 16e / 17e",
  "428x926@3": "iPhone 12–13 Pro Max / 14 Plus",
  "393x852@3": "iPhone 14 Pro / 15 / 15 Pro / 16",
  "430x932@3": "iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus",
  "402x874@3": "iPhone 16 Pro / 17 / 17 Pro",
  "420x912@3": "iPhone Air",
  "440x956@3": "iPhone 16–17 Pro Max",
};

/** Samsung Galaxy model codes (letter + 3 digits, region suffix dropped) → name. Unknown codes show as sent. */
const SAMSUNG: Record<string, string> = {
  G970: "Galaxy S10e",
  G973: "Galaxy S10",
  G975: "Galaxy S10+",
  G980: "Galaxy S20",
  G981: "Galaxy S20",
  G985: "Galaxy S20+",
  G986: "Galaxy S20+",
  G988: "Galaxy S20 Ultra",
  G780: "Galaxy S20 FE",
  G781: "Galaxy S20 FE",
  G990: "Galaxy S21 FE",
  G991: "Galaxy S21",
  G996: "Galaxy S21+",
  G998: "Galaxy S21 Ultra",
  S901: "Galaxy S22",
  S906: "Galaxy S22+",
  S908: "Galaxy S22 Ultra",
  S711: "Galaxy S23 FE",
  S911: "Galaxy S23",
  S916: "Galaxy S23+",
  S918: "Galaxy S23 Ultra",
  S721: "Galaxy S24 FE",
  S921: "Galaxy S24",
  S926: "Galaxy S24+",
  S928: "Galaxy S24 Ultra",
  S731: "Galaxy S25 FE",
  S931: "Galaxy S25",
  S936: "Galaxy S25+",
  S937: "Galaxy S25 Edge",
  S938: "Galaxy S25 Ultra",
  S942: "Galaxy S26",
  S947: "Galaxy S26+",
  S948: "Galaxy S26 Ultra",
  N970: "Galaxy Note10",
  N975: "Galaxy Note10+",
  N981: "Galaxy Note20",
  N986: "Galaxy Note20 Ultra",
  F711: "Galaxy Z Flip3",
  F721: "Galaxy Z Flip4",
  F731: "Galaxy Z Flip5",
  F741: "Galaxy Z Flip6",
  F761: "Galaxy Z Flip7",
  F926: "Galaxy Z Fold3",
  F936: "Galaxy Z Fold4",
  F946: "Galaxy Z Fold5",
  F956: "Galaxy Z Fold6",
  F966: "Galaxy Z Fold7",
  A025: "Galaxy A02s",
  A035: "Galaxy A03s",
  A037: "Galaxy A03s",
  A045: "Galaxy A04",
  A047: "Galaxy A04s",
  A055: "Galaxy A05",
  A057: "Galaxy A05s",
  A102: "Galaxy A10e",
  A105: "Galaxy A10",
  A107: "Galaxy A10s",
  A115: "Galaxy A11",
  A125: "Galaxy A12",
  A135: "Galaxy A13",
  A136: "Galaxy A13 5G",
  A145: "Galaxy A14",
  A146: "Galaxy A14 5G",
  A155: "Galaxy A15",
  A156: "Galaxy A15 5G",
  A165: "Galaxy A16",
  A166: "Galaxy A16 5G",
  A175: "Galaxy A17",
  A176: "Galaxy A17 5G",
  A205: "Galaxy A20",
  A215: "Galaxy A21",
  A217: "Galaxy A21s",
  A225: "Galaxy A22",
  A226: "Galaxy A22 5G",
  A235: "Galaxy A23",
  A236: "Galaxy A23 5G",
  A245: "Galaxy A24",
  A256: "Galaxy A25 5G",
  A266: "Galaxy A26 5G",
  A305: "Galaxy A30",
  A315: "Galaxy A31",
  A325: "Galaxy A32",
  A326: "Galaxy A32 5G",
  A336: "Galaxy A33 5G",
  A346: "Galaxy A34 5G",
  A356: "Galaxy A35 5G",
  A366: "Galaxy A36 5G",
  A505: "Galaxy A50",
  A515: "Galaxy A51",
  A516: "Galaxy A51 5G",
  A525: "Galaxy A52",
  A526: "Galaxy A52 5G",
  A528: "Galaxy A52s 5G",
  A536: "Galaxy A53 5G",
  A546: "Galaxy A54 5G",
  A556: "Galaxy A55 5G",
  A566: "Galaxy A56 5G",
  A705: "Galaxy A70",
  A715: "Galaxy A71",
  A716: "Galaxy A71 5G",
};
