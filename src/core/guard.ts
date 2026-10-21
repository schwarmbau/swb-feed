// Memory defense: nothing reaches a ledger, a model or a sink until secrets are
// replaced by a typed marker and private spans are gone. Broad on purpose: this
// runs at a write boundary, where a false positive costs a word and a miss costs a key.

import { decodeEntities, splitHidden } from "./text.ts";

const SECRET_SHAPES: { label: string; re: RegExp }[] = [
  { label: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: "openai_key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { label: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { label: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: "aws_secret_key", re: /\b(?:aws_secret_access_key|aws_secret_key|secret_access_key|SecretAccessKey)["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi },
  { label: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { label: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { label: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  // The value of a password assignment; zero hits on the 1,656-row ledger of 2026-10-21 (D9).
  { label: "password", re: /\b(?:password|passwd|pwd|passwort|kennwort)\b["']?\s*[:=]\s*["']?[^\s"'<>,;)\]]{6,}/gi },
  { label: "connection_string", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi },
  { label: "iban", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
];

/**
 * Removes <private>…</private> spans, nested ones included (depth-counted, so the outer span's
 * tail never leaks). An unclosed opening tag suppresses the rest (fail closed); an orphan
 * closing tag is dropped as markup.
 */
export function stripPrivate(text: string): string {
  const tag = /<(\/?)private\b[^>]*>/gi;
  let out = "";
  let depth = 0;
  let last = 0;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    if (depth === 0) out += text.slice(last, m.index);
    if (m[1]) depth = Math.max(0, depth - 1);
    else depth++;
    last = tag.lastIndex;
  }
  return depth === 0 ? out + text.slice(last) : out;
}

export interface GuardResult {
  text: string;
  redactions: string[];
}

export function guard(text: string): GuardResult {
  let out = stripPrivate(text);
  const redactions: string[] = [];
  for (const { label, re } of SECRET_SHAPES) {
    out = out.replace(re, () => {
      redactions.push(label);
      return `[REDACTED:${label}]`;
    });
  }
  return { text: out, redactions };
}

// ── Risk: what the guard flags but never changes ─────────────────────────────────────────────────
// Prompt injection and hidden text are judged on a matching copy (invisibles out, tag characters
// decoded, NFKC, look-alike letters folded, lower case); the stored text stays as it arrived.
// A flag is derived like a grade: computed from the stored item whenever it is routed, so every
// row in the ledger is covered the day a rule changes, and nothing is written. Flags only tighten:
// they can keep an item out of a sink, never let it into one.

import type { Risk, RiskLevel } from "../contracts/ledger.ts";
export type { Risk, RiskLevel };

/** Flags a source or the PII stage attaches to an item start with this; `assess` reads them back. */
export const GUARD_FLAG = "guard:";

const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/g;
// Zero-width characters inside a word. ZWJ between emoji, soft hyphens and RTL marks are ordinary text.
const ZERO_WIDTH_IN_WORD = /(?<=\p{L})[\u200B\u200C\u200D\u2060\uFEFF]+(?=\p{L})/gu;
// A run of variation selectors can carry bytes (one selector per byte): decoded, so what it hides is matched.
const SELECTOR_RUN = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]{3,}/gu;

function decodeSelectors(run: string): string {
  const bytes = [...run].map((c) => {
    const cp = c.codePointAt(0)!;
    return cp >= 0xe0100 ? cp - 0xe0100 + 16 : cp - 0xfe00;
  });
  return ` ${new TextDecoder().decode(new Uint8Array(bytes)).replace(/[^\x20-\x7e]/g, "")} `;
}

// One code point each, Cyrillic and Greek letters that look like Latin ones.
const CONFUSABLE: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w", һ: "h", ӏ: "l",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", γ: "y", ѵ: "v",
};

/** The text a signature is matched against: never stored, never shown. */
export function matchingCopy(text: string): string {
  const folded = text
    .replace(TAG_CHARS, (c) => {
      const cp = c.codePointAt(0)! - 0xe0000;
      return cp >= 0x20 && cp < 0x7f ? String.fromCharCode(cp) : "";
    })
    .replace(SELECTOR_RUN, decodeSelectors)
    .replace(/[\p{Cf}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[Ͱ-ӿ]/g, (c) => CONFUSABLE[c] ?? c);
  // Letter-spaced words ("i g n o r e") are joined, so a signature needs no spacing variant.
  return folded.replace(/\b(?:\p{L} ){3,}\p{L}\b/gu, (run) => run.replace(/ /g, ""));
}

/** Format characters, selectors and tag characters out: what a prompt or a memory view gets instead. */
export const stripInvisible = (s: string) => s.replace(/[\p{Cf}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "");

/** Text a reader sees normally hides nothing; these do. */
export function invisibleFlags(text: string): string[] {
  const out: string[] = [];
  // A subdivision flag emoji (🏴 + tag letters + cancel tag) is the one ordinary use of tag characters.
  const tags = text.replace(/\u{1F3F4}[\u{E0020}-\u{E007E}]{1,6}\u{E007F}/gu, "").match(TAG_CHARS)?.length ?? 0;
  if (tags) out.push("hidden:tag_chars");
  if (SELECTOR_RUN.test(text)) out.push("hidden:variation_selectors");
  SELECTOR_RUN.lastIndex = 0;
  if (BIDI_CONTROL.test(text)) out.push("hidden:bidi_control");
  BIDI_CONTROL.lastIndex = 0;
  if ((text.match(ZERO_WIDTH_IN_WORD)?.length ?? 0) >= 2) out.push("hidden:zero_width");
  return out;
}

const SIGNATURES: { flag: string; re: RegExp }[] = [
  {
    flag: "injection:override",
    re: /\b(?:ignore|disregard|forget|override|bypass)\b(?:\W+\w+){0,4}?\W+(?:instructions?|prompts?|directions|directives|guidelines|rules|guardrails)\b|\b(?:ignorier\w*|vergiss)\b(?:\W+\w+){0,3}?\W+(?:anweisungen|instruktionen|befehle|vorgaben|regeln)\b|\b(?:ignore[zs]?|oublie[zs]?)\b(?:\W+\w+){0,3}?\W+(?:instructions|consignes|r[eè]gles)\b/u,
  },
  {
    flag: "injection:persona",
    re: /\byou are now\b(?! (?:subscribed|signed|logged|registered|connected|enrolled|on the list|ready|able))|\bfrom now on,? you\b|\b(?:you(?:'re| are)(?: now)? in|enter|activate|switch to|enable) (?:developer|god|dan|jailbreak|unrestricted) mode\b(?! (?:on|in|of|for|under) (?:your|the|my) (?:phone|tv|device|android|iphone|browser|settings))|\b(?:god|dan|jailbreak|unrestricted) mode\b|\bact as (?:an? )?(?:unrestricted|unfiltered|jailbroken)\b|\bdu bist (?:jetzt|ab sofort) (?:eine? )?(?:ki|assistent|sprachmodell|uneingeschr[aä]nkt\w*|dan)\b/u,
  },
  {
    flag: "injection:addressed",
    re: /\b(?:note|message|instructions?|reminder|attention|psa|hint|request)s?\W+(?:to|for)\W+(?:any|all|every|the|each)?\W*(?:ai|llms?|language models?|assistants?|chatbots?|agents?|summari[sz]ers?|crawlers?|bots?|models?)\b|\bto (?:the|any|all) (?:ai|llm|language model|assistant|model|agent|bot)s?\b(?:\W+\w+){0,2}?\W+(?:reading|processing|summari[sz]ing|parsing|analy[sz]ing|ingesting|crawling)\b|\bif you(?:'re| are) (?:an? )?(?:ai|llm|large language model|language model|assistant|chatbot|bot|agent)\b|\bdear (?:ai|llm|assistant|model|agent|chatbot)\b|\b(?:ai|llm) (?:assistants?|models?|agents?|systems?)\W+(?:reading|processing|summari[sz]ing|ingesting|parsing)\b|\b(?:hinweis|nachricht|anweisung|notiz|bitte|achtung)\W+(?:an|f[uü]r)\W+(?:alle|jede|jeden|die|das)?\W*(?:ki|sprachmodelle?|assistent\w*)\b(?!-)|\b(?:falls|wenn) du (?:eine|ein) (?:ki|sprachmodell|ki-assistent)\b(?!-)|\bsi vous [eê]tes une? (?:ia|assistant)\b|\b[aà] (?:toute|toutes les|l') ?ia\b/u,
  },
  {
    flag: "injection:rating",
    re: /\b(?:rate|score|rank|grade|mark|classify|label|tier|flag|treat|list)\b(?:\W+\w+){0,5}?\W+(?:10 ?\/ ?10|10 out of 10|100 ?\/ ?100|5 stars|highly relevant|most relevant|maximum relevance|top story|top priority|s[- ]tier|tier s|must[- ]read|urgent|critical priority|highest (?:priority|relevance|score|quality))\b/u,
  },
  {
    flag: "injection:output",
    re: /\b(?:append|include|add|insert|embed|put|place)\b(?:\W+\w+){0,4}?\W+(?:url|link|image|pixel|text|line|sentence)\b(?:\W+\w+){0,3}?\W+(?:to|in|into|at the end of) (?:your|the|every|each) (?:summary|summaries|answer|response|reply|output|digest)\b|\b(?:reply|respond|answer)(?: only)? with(?: only)? (?:the word|the phrase|this|["'‘“])/u,
  },
  {
    flag: "injection:disclosure",
    re: /\b(?:reveal|print|repeat|output|show|disclose|dump|leak|share|tell me)\b(?:\W+\w+){0,3}?\W+(?:(?:your|the) (?:system prompt|initial prompt|hidden prompt|system message|developer message)|(?:instructions|message|prompt) you were given|your (?:\w+ ){0,2}(?:instructions|prompt|configuration|api keys?|credentials|access tokens?|environment variables|context window))\b|\bsystem prompt\s*:/u,
  },
  {
    // Steering what the reader writes: a directive and "your summary/answer/…" in one sentence.
    flag: "injection:output",
    re: /\b(?:include|append|add|insert|embed|render|put|place|mention|write|paste)\b[^.!?\n]{0,120}\b(?:in|into|to|at the end of|at the top of) your (?:summary|summaries|digest|answer|response|reply|output|report|rating)\b|\b(?:in|into) your (?:summary|summaries|digest|answer|response|reply|output|report)\b[^.!?\n]{0,40}\b(?:include|append|add|insert|embed|render|mention|write|link)\b/u,
  },
  {
    flag: "injection:tool",
    re: /\b(?:use|call|invoke|run|trigger|execute)\b(?: your| the)? [\w.-]+[ _](?:tool|function|plugin|action)\b|\b(?:send_email|send_message|http_request|run_shell|execute_code|browse|fetch_url)\s*\(|\b(?:forward|send|email|post|upload|exfiltrate|copy)\b(?:\W+\w+){0,3}?\W+(?:the user'?s?|all|your|the owner'?s?|private)\W+(?:\w+\W+)?(?:messages|emails|mails|files|data|conversations?|history|context|memory|notes|credentials|contacts)\b/u,
  },
  {
    flag: "injection:authority",
    re: /\btreat (?:it|this)(?:\W+\w+){0,3}?\W+as (?:written|sent|authored|coming|issued) (?:by|from) the (?:user|owner|admin|developer|operator)\b|\bpre-?approved\b|\b(?:the user|the owner|your owner|the admin) has (?:already )?(?:approved|authori[sz]ed|confirmed)\b/u,
  },
  {
    flag: "markup:role",
    re: /<\|(?:im_start|im_end|system|user|assistant|endoftext|start_header_id|end_header_id|eot_id|begin_of_text)\|>|\[\/?inst\]|<<\/?sys>>|<\/?(?:system|system_prompt|instructions?)>|<(?:start|end)_of_turn>|^#{2,4} ?(?:instruction|system|response|input)s?:|^\[(?:system|admin|developer)(?: message| note| prompt)?\]|^\s*(?:system|developer)\s*:\s*(?:you|ignore|new)/mu,
  },
  {
    flag: "markup:turns",
    re: /^\s*(?:human|user)\s*:.*\n(?:.*\n){0,6}?\s*(?:assistant|ai)\s*:/mu,
  },
  {
    flag: "markup:tool_call",
    re: /<\/?(?:function_calls|function_results|tool_call|tool_use|tool_result|invoke)\b|"(?:tool_calls|function_call)"\s*:|"role"\s*:\s*"(?:system|tool)"/u,
  },
];

// A Markdown or HTML link whose URL carries a placeholder or a data-shaped parameter: rendered, it sends something out.
const TEMPLATE = /\{\{[^}]*\}\}|\$\{[^}]*\}|%7[bB]%7[bB]|%24%7[bB]|\[[A-Za-z_]{4,}\]|%5[bB][A-Za-z_]{4,}%5[dD]|<(?:secret|token|data|api_key|conversation|history)>|=(?:[A-Z][A-Z0-9]*_)+[A-Z0-9]+(?=&|$)/;
const DATA_PARAM = /[?&](?:data|d|secret|token|key|apikey|api_key|session|sid|cookie|pw|pass|password|msg|message|chat|history|ctx|context|conv|conversation|prompt|leak|exfil|payload|creds?|user_?data)=/i;
const LINK = /!?\[[^\]\n]*\]\(\s*<?(https?:\/\/[^\s)>]+)|^\s*\[[^\]\n]+\]:\s*<?(https?:\/\/\S+)|<img\b[^>]*\bsrc\s*=\s*["']?((?:https?:)?\/\/[^\s"'>]+)|<a\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^\s"'>]+)/gimu;

export function exfilLink(text: string): boolean {
  for (const m of text.matchAll(LINK)) {
    const url = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    const image = m[0].startsWith("!") || m[0].startsWith("<img") || /^\s*\[/.test(m[0]);
    if (TEMPLATE.test(url) || (image && DATA_PARAM.test(url))) return true;
    // An image whose error handler appends page data to its own address.
    if (m[0].startsWith("<img") && /\bon\w+\s*=[^>]*(?:document\.cookie|localstorage|location|\.src\s*\+?=)/i.test(text.slice(m.index!, text.indexOf(">", m.index!) + 1))) return true;
  }
  return false;
}

// A paragraph that discusses attacks (a security article, a template tutorial) lowers a
// signature hit from suspect to note. Hidden text, tag characters and exfil links never lower.
const META = /prompt[- ]injection|jailbreak|\battack(?:er|ers|s)?\b|\bpayloads?\b|\bexamples?\b|\be\.g\.|\bsuch as\b|\bfor instance\b|\btemplates?\b|\btutorial\b|\btokeni[sz]er\b|\bmarkers?\b|\bspecial tokens?\b|fine-?tun|\bformat(?:ted|s)?\b|\bresearchers?\b|\bthe paper\b|\bcorpus\b|\bred[- ]team|\bregex|\bsamples?\b|\bdocumented\b|\btextbook\b|\bphishing\b|\bmalicious\b|\bpoison|\bmitigat|\bdefen[cs]e|\bin the wild\b|\bangriff|\bbeispiel/iu;
const QUOTED = /["“„«‘'`][^"”“«»‘’'`\n]{6,200}["”“»’'`]/gu;

// A host name or an address is not discussion ("collector.example" is not an example).
const ADDRESSES = /\bhttps?:\/\/\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[\w-]+(?:\.[\w-]+)*\.(?:example|com|org|net|io|dev|de|ai)\b/g;

function levelOf(paragraph: string, at: number): "note" | "suspect" {
  if (META.test(paragraph.replace(ADDRESSES, " "))) return "note";
  for (const q of paragraph.matchAll(QUOTED)) if (q.index! <= at && at < q.index! + q[0].length) return "note";
  return "suspect";
}

/** The risk of an item: its title and content, and the guard flags its source attached. */
// Views and rules ask for every item's risk on every run; a stored item never changes, so it is assessed once per process.
const RISK_CACHE = new Map<string, Risk>();

export function riskOf(e: { title: string; content: string; flags?: string[]; content_hash?: string }): Risk {
  const key = e.content_hash ? `${e.content_hash}\u0000${e.title}\u0000${(e.flags ?? []).join("\u0001")}` : undefined;
  const hit = key ? RISK_CACHE.get(key) : undefined;
  if (hit) return hit;
  const r = assess(`${e.title}\n\n${e.content}`, e.flags ?? []);
  if (key) RISK_CACHE.set(key, r);
  return r;
}

/** The risk of a text and the guard flags already on its item. Pure: same input, same answer. */
export function assess(text: string, itemFlags: readonly string[] = []): Risk {
  const flags = new Set<string>();
  let level: RiskLevel = "none";
  const raise = (l: RiskLevel) => {
    if (l === "suspect" || (l === "note" && level === "none")) level = l;
  };
  for (const f of itemFlags) {
    if (!f.startsWith(GUARD_FLAG)) continue;
    const name = f.slice(GUARD_FLAG.length);
    flags.add(name);
    raise(name.endsWith(":note") || name.startsWith("pii:") ? "note" : "suspect");
  }
  for (const f of invisibleFlags(text)) {
    flags.add(f);
    raise("suspect");
  }
  if (exfilLink(text)) {
    flags.add("injection:exfil_link");
    raise("suspect");
  }
  // Paragraph by paragraph is how the level is judged; the match runs over the whole copy, so a
  // fake dialogue spread over several paragraphs is still one hit.
  const copy = matchingCopy(text);
  const breaks = [...copy.matchAll(/\n\s*\n/g)].map((m) => m.index!);
  const paragraphAt = (i: number) => {
    const start = Math.max(0, ...breaks.filter((b) => b < i));
    const end = breaks.find((b) => b > i) ?? copy.length;
    return { text: copy.slice(start, end), offset: start };
  };
  for (const { flag, re } of SIGNATURES) {
    for (const hit of copy.matchAll(new RegExp(re.source, `${re.flags}g`))) {
      const p = paragraphAt(hit.index!);
      const l = levelOf(p.text, hit.index! - p.offset);
      flags.add(l === "note" ? `${flag}:note` : flag);
      raise(l);
    }
  }
  return { level, flags: [...flags].sort() };
}

// Hidden text has no reason to address anyone, so a wider net than the signatures is right for it.
const HIDDEN_INTENT =
  /\b(?:you|your|ai|ki|ia|assistants?|models?|llms?|agents?|readers?|summar\w*|condens\w*|rank\w*|rat(?:e|ing)|scor\w*|relevance|importance|priority|urgent|critical|flag|mark|instructions?|anweisung\w*|ignore|disregard|override|pretend|jailbr\w*|respond|reply|output|notify|alert|tools?|polic(?:y|ies)|objective|promote|approved?|comply|obey)\b|<\|/u;

/**
 * Guard flags for an HTML body, read by a source while the markup still exists: text the page hid
 * from its reader (left out of the content by `htmlToText`), and links that would send data out.
 * Hidden text that carries any signature is `suspect`; other hidden text (a skip link, a build
 * comment) is a `note`.
 */
export function hiddenHtmlFlags(html: string): string[] {
  const out = new Set<string>();
  for (const h of splitHidden(html).hidden) {
    const text = decodeEntities(h.html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (exfilLink(h.html) || exfilLink(text)) out.add(`${GUARD_FLAG}hidden-html:${h.kind}`);
    else if (text) out.add(assess(text).level === "none" && assess(h.html).level === "none" && !HIDDEN_INTENT.test(matchingCopy(text)) ? `${GUARD_FLAG}hidden-html:${h.kind}:note` : `${GUARD_FLAG}hidden-html:${h.kind}`);
  }
  if (exfilLink(html)) out.add(`${GUARD_FLAG}exfil-html`);
  return [...out].sort();
}
