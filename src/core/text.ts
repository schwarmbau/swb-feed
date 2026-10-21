// Small, dependency-free text helpers: entity decoding, HTML to text, sentences, slugs, hashing.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", uuml: "ü", ouml: "ö",
  auml: "ä", Uuml: "Ü", Ouml: "Ö", Auml: "Ä", szlig: "ß", eacute: "é", copy: "©",
  reg: "®", trade: "™", euro: "€", laquo: "«", raquo: "»", bull: "•", middot: "·", times: "×",
  egrave: "è", agrave: "à", ccedil: "ç", ntilde: "ñ", oacute: "ó", aacute: "á", iacute: "í",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

export function unCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

export function htmlToText(html: string): string {
  return decodeEntities(
    splitHidden(html).visible
      .replace(/<(script|style|noscript|svg|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|section|article)>/gi, "\n\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${cut.slice(0, at > max * 0.6 ? at : max).trimEnd()}…`;
}

export function slug(text: string, max = 60): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "item"
  );
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Normalizes a URL for identity: lowercase host, no fragment, no tracking params, no trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    }
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

/** Lowercased word tokens, umlauts kept, for matching an intent profile. */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9äöüß][a-z0-9äöüß+#.-]*/g) ?? [];
}

// Text a browser reader never sees: a hidden element's text or an HTML comment. `htmlToText`
// leaves it out of the content, and `hiddenHtmlFlags` says what was left out, so the guard can
// flag an item whose page hid something from its reader.
const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "embed"]);
const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*(?:0|[01](?:\.\d+)?px)\b|opacity\s*:\s*0(?:\.0+)?(?![.\d])|(?:left|top|text-indent|margin-left)\s*:\s*-\d{3,}px|clip\s*:\s*rect\(\s*0|(?:max-)?height\s*:\s*0(?:px)?\s*;[^"']*overflow\s*:\s*hidden|color\s*:\s*(?:#fff(?:fff)?|white)\b[^"']*background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b|background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b[^"']*[^-]color\s*:\s*(?:#fff(?:fff)?|white)\b/i;

export type HiddenKind = "css" | "attribute" | "aria" | "class" | "comment";

function hiddenKind(attrs: string): HiddenKind | undefined {
  const style = /\bstyle\s*=\s*("[^"]*"|'[^']*')/i.exec(attrs)?.[1] ?? "";
  if (HIDDEN_STYLE.test(style)) return "css";
  if (/(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)) return "attribute";
  if (/\baria-hidden\s*=\s*["']?true/i.test(attrs)) return "aria";
  if (/\bclass\s*=\s*["'][^"']*\b(?:sr-only|visually-hidden|screen-reader-text|hidden)\b/i.test(attrs)) return "class";
  return undefined;
}

/** The HTML without what a reader cannot see, and what was cut (its kind and its HTML). */
export function splitHidden(html: string): { visible: string; hidden: { kind: HiddenKind; html: string }[] } {
  const hidden: { kind: HiddenKind; html: string }[] = [];
  let s = html.replace(/<!--(?!\s*\[if)([\s\S]*?)-->/g, (_, body: string) => {
    if (body.trim()) hidden.push({ kind: "comment", html: body });
    return " ";
  });
  const open = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const kind = hiddenKind(m[2]);
    if (!kind) continue;
    const tag = m[1].toLowerCase();
    let end = open.lastIndex;
    if (!VOID.has(tag) && !m[0].endsWith("/>")) {
      // Depth-counted, so a hidden element's nested children go with it; an unclosed one hides the rest.
      const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
      re.lastIndex = end;
      let depth = 1;
      end = s.length;
      for (let t = re.exec(s); t; t = re.exec(s)) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) {
          end = re.lastIndex;
          break;
        }
      }
    }
    hidden.push({ kind, html: s.slice(m.index, end) });
    s = `${s.slice(0, m.index)} ${s.slice(end)}`;
    open.lastIndex = m.index;
  }
  return { visible: s, hidden };
}
