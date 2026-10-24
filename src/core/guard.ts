// Memory defense: nothing reaches a ledger, a model or a sink until secrets are
// replaced by a typed marker and private spans are gone. Broad on purpose: this
// runs at a write boundary, where a false positive costs a word and a miss costs a key.

import { decodeEntities, sha256, splitHidden } from "./text.ts";
import { ibanValid } from "./pii.ts";

const SECRET_SHAPES: { label: string; re: RegExp; valid?: (m: string) => boolean }[] = [
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
  // The same shape in any case, only when its checksum holds: lower case is too common in ordinary text to redact on shape alone.
  { label: "iban", re: /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){3,7}(?: ?[A-Za-z0-9]{1,3})?\b/g, valid: ibanValid },
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
  for (const { label, re, valid } of SECRET_SHAPES) {
    out = out.replace(re, (m) => {
      if (valid && !valid(m)) return m;
      redactions.push(label);
      return `[REDACTED:${label}]`;
    });
  }
  return { text: out, redactions };
}

// ── Risk: what the guard flags but never changes ─────────────────────────────────────────────────
// Prompt injection and hidden text are judged on a matching copy (invisibles out, tag characters
// decoded, marks off Latin letters, NFKC, look-alike letters folded, lower case); the stored text
// stays as it arrived. A flag is derived like a grade: computed from the stored item whenever it is
// routed, so every row in the ledger is covered the day a rule changes, and nothing is written.
// Flags only tighten, and nothing an item says can lower its level: a signature hit is suspect
// whether it is quoted, framed as an example or wrapped in an article about attacks.

import type { Risk, RiskLevel } from "../contracts/ledger.ts";
export type { Risk, RiskLevel };

/** Flags a source or the PII stage attaches to an item start with this; `assess` reads them back. */
export const GUARD_FLAG = "guard:";

const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/g;
// Joiners and fillers no font draws, which are not format characters: the combining grapheme joiner and the Hangul fillers.
const FILLERS = "\u034F\u115F\u1160\u3164\uFFA0";
const INVISIBLE = new RegExp(`[\\p{Cf}\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}${FILLERS}]`, "gu");
const SMALL_SCRIPT = "\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}";
// Zero-width characters inside a word. One between two Latin, Greek or Cyrillic letters is enough;
// elsewhere (ZWNJ in Persian or Hindi, ZWJ in Indic scripts) only a run of them counts.
const ZERO_WIDTH_IN_WORD = /(?<=\p{L})[\u200B\u200C\u200D\u2060\uFEFF]+(?=\p{L})/gu;
const ZERO_WIDTH_IN_LATIN = new RegExp(`(?<=[${SMALL_SCRIPT}])[\\u200B\\u200C\\u200D\\u2060\\uFEFF]+(?=[${SMALL_SCRIPT}])`, "u");
const FILLER_IN_WORD = new RegExp(`(?<=[${SMALL_SCRIPT}])[${FILLERS}]+|[${FILLERS}]+(?=[${SMALL_SCRIPT}])`, "u");
// A run of variation selectors can carry bytes (one selector per byte): decoded, so what it hides is matched.
const SELECTOR_RUN = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]{3,}/gu;

function decodeSelectors(run: string): string {
  const bytes = [...run].map((c) => {
    const cp = c.codePointAt(0)!;
    return cp >= 0xe0100 ? cp - 0xe0100 + 16 : cp - 0xfe00;
  });
  return ` ${new TextDecoder().decode(new Uint8Array(bytes)).replace(/[^\x20-\x7e]/g, "")} `;
}

// One code point each, letters of other scripts and Latin small capitals that look like Latin letters.
const CONFUSABLE: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w", һ: "h", ӏ: "l",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", γ: "y", ѵ: "v",
  օ: "o", ս: "u", ց: "g", հ: "h", ո: "n", ա: "w", զ: "q", ı: "i", ȷ: "j", ɡ: "g", ɑ: "a", ʟ: "l",
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ǫ: "q", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "gu");
// A letter written with a mark (a combining dot over "i") is matched as the letter.
const MARK_ON_LATIN = /(?<=[a-zA-Z])\p{M}+/gu;
// Single letters split by one repeated separator ("i-g-n-o-r-e", "I.g.n.o.r.e", "i g n o r e") are joined.
const SPLIT_WORD = /(?<!\p{L})\p{L}([ .\-_*/|·•~+])(?:\p{L}\1){2,}\p{L}(?!\p{L})/gu;

/** Invisibles out, tag characters and selector runs decoded, NFKC, lower case: what a reader would read. */
function readable(text: string): string {
  return text
    .replace(TAG_CHARS, (c) => {
      const cp = c.codePointAt(0)! - 0xe0000;
      return cp >= 0x20 && cp < 0x7f ? String.fromCharCode(cp) : "";
    })
    .replace(SELECTOR_RUN, decodeSelectors)
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .toLowerCase();
}

/** The text a Latin-script signature is matched against: never stored, never shown. */
export function matchingCopy(text: string): string {
  const folded = readable(text)
    .normalize("NFKD")
    .replace(MARK_ON_LATIN, "")
    .normalize("NFKC")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLE[c] ?? c);
  return folded.replace(SPLIT_WORD, (run, sep: string) => run.split(sep).join(""));
}

/** Format characters, selectors, tag characters, joiners and fillers out: what a prompt or a memory view gets instead. */
export const stripInvisible = (s: string) => s.replace(INVISIBLE, "");

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
  // German CMSes put one zero-width space into long compounds as a break opportunity: one alone is a note.
  if ((text.match(ZERO_WIDTH_IN_WORD)?.length ?? 0) >= 2) out.push("hidden:zero_width");
  else if (ZERO_WIDTH_IN_LATIN.test(text)) out.push("hidden:zero_width:single");
  if (FILLER_IN_WORD.test(text)) out.push("hidden:filler");
  return out;
}

// Verbs and objects of an instruction override, per language (Latin scripts are matched without marks).
const OVERRIDE_EN =
  /\b(?:ignore|ignoring|disregard|disregarding|forget|override|bypass|disobey|pay no attention to|do not follow|don'?t follow|stop following|set aside)\b(?:\W+\w+){0,4}?\W+(?:instructions?|prompts?|directions|directives|guidelines|guidance|rules|guardrails|orders|commands|constraints|programming|system (?:prompt|message)|rubric)\b/u;
const OVERRIDE_EU = new RegExp(
  [
    // German
    String.raw`\b(?:ignorier\w*|vergiss|vergessen sie|missacht\w*|ubergeh\w*|beachte\w* (?:keine|nicht)|setz\w* (?:dich |sich )?uber)\b(?:\W+\w+){0,4}?\W+(?:anweisung\w*|instruktion\w*|befehl\w*|vorgabe\w*|regel\w*|richtlinie\w*|vorschrift\w*|hinweis\w*|bewertungsregel\w*)\b`,
    // French
    String.raw`\b(?:ignore[zs]?|oublie[zs]?|ne tiens pas compte|ne tenez pas compte)\b(?:\W+\w+){0,4}?\W+(?:instructions|consignes|regles|directives|indications)\b`,
    // Spanish, Portuguese, Italian
    String.raw`\b(?:ignora|ignore|ignorad|olvida|olvide|omite|descarta|haz caso omiso de|esqueca|desconsidere|ignorate|dimentica|dimenticate|trascura|non seguire)\b(?:\W+\w+){0,4}?\W+(?:instrucciones|indicaciones|reglas|ordenes|directrices|instrucoes|regras|orientacoes|istruzioni|indicazioni|regole|direttive)\b`,
    // Dutch, Polish, Romanian, Turkish
    String.raw`\b(?:negeer|vergeet|negeren|zignoruj|ignoruj|zapomnij|ignora|uita)\b(?:\W+\w+){0,4}?\W+(?:instructies|aanwijzingen|regels|opdrachten|instrukcj\w*|polece\w*|zasad\w*|instructiuni\w*|regul\w*)\b`,
    String.raw`\b(?:talimat\w*|kural\w*|yonerge\w*)\b(?:\W+\w+){0,3}?\W+(?:yok say\w*|gormezden gel\w*|unut\w*)`,
  ].join("|"),
  "u",
);
// Scripts without a Latin fold are matched on the readable copy, in their own letters.
const OVERRIDE_NATIVE =
  /(?:игнорируй\w*|проигнорируй\w*|забудь\w*|не обращай\w* внимани\w* на|ігноруй\w*)(?:\s+\S+){0,4}?\s+(?:инструкци\w*|указани\w*|правил\w*|команд\w*|інструкці\w*)|(?:忽略|无视|忽视|無視|不要理会|不要理會|别管)[^。！？\n]{0,12}(?:指令|指示|说明|說明|规则|規則|提示|要求)|(?:指示|命令|ルール|プロンプト|指令)[^。！？\n]{0,12}(?:無視|忘れ)|(?:지시|명령|지침|규칙)[^.!?\n]{0,12}(?:무시|잊어)|(?:تجاهل|انس)[^.!?\n]{0,30}(?:التعليمات|الأوامر|القواعد|تعليمات)/u;

const SIGNATURES: { flag: string; re: RegExp; native?: true }[] = [
  { flag: "injection:override", re: OVERRIDE_EN },
  { flag: "injection:override", re: OVERRIDE_EU },
  { flag: "injection:override", re: OVERRIDE_NATIVE, native: true },
  {
    flag: "injection:persona",
    re: /\byou are now\b(?! (?:subscribed|signed|logged|registered|connected|enrolled|on the list|ready|able))|\bfrom now on,? you (?:are|will (?:be|act|answer|respond|reply|only|ignore|obey|follow)|must (?:act|answer|respond|reply|obey|ignore|only|follow)|answer|respond|reply|act|obey|only)\b|\b(?:you(?:'re| are)(?: now)? in|enter|activate|switch to|enable) (?:developer|god|dan|jailbreak|unrestricted) mode\b(?! (?:on|in|of|for|under) (?:your|the|my) (?:phone|tv|device|android|iphone|browser|settings))|\b(?:god|dan|jailbreak|unrestricted) mode\b|\bact as (?:an? )?(?:unrestricted|unfiltered|jailbroken)\b|\bdu bist (?:jetzt|ab sofort) (?:eine? )?(?:ki|assistent|sprachmodell|uneingeschrankt\w*|dan)\b/u,
  },
  {
    flag: "injection:addressed",
    re: /\b(?:note|message|instructions?|reminder|attention|psa|hint|request)s?\W+(?:to|for)\W+(?:any|all|every|the|each)?\W*(?:ai|llms?|language models?|assistants?|chatbots?|agents?|summari[sz]ers?|crawlers?|bots?|models?)\b|\bto (?:the|any|all) (?:ai|llm|language model|assistant|model|agent|bot)s?\b(?:\W+\w+){0,2}?\W+(?:reading|processing|summari[sz]ing|parsing|analy[sz]ing|ingesting|crawling)\b|\bif you(?:'re| are) (?:an? )?(?:ai|llm|large language model|language model|assistant|chatbot|bot|agent)\b|\bdear (?:ai|llm|assistant|model|agent|chatbot)\b|\b(?:ai|llm) (?:assistants?|models?|agents?|systems?)\W+(?:reading|processing|summari[sz]ing|ingesting|parsing)\b|\b(?:hey|hi|hello|dear|ok|okay|psst)\W+(?:claude|chatgpt|gpt(?:-?\d[\w.]*)?|gemini|copilot|llama|grok|mistral|bard)\b|\b(?:hinweis|nachricht|anweisung|notiz|bitte|achtung)\W+(?:an|fur)\W+(?:alle|jede|jeden|die|das)?\W*(?:ki|sprachmodelle?|assistent\w*)\b(?!-)|\b(?:falls|wenn) du (?:eine|ein) (?:ki|sprachmodell|ki-assistent)\b(?!-)|\bsi vous etes une? (?:ia|assistant)\b|\ba (?:toute|toutes les|l') ?ia\b/u,
  },
  {
    // Within one line: a source's own metadata ("label" … "(tier s)" two lines down) is not a request.
    flag: "injection:rating",
    re: /\b(?:rate|score|rank|grade|mark|classify|label|tier|flag|treat|list)\b(?:[^\w\n]+\w+){0,5}?[^\w\n]+(?:10 ?\/ ?10|10 out of 10|100 ?\/ ?100|5 stars|highly relevant|most relevant|maximum relevance|top story|top priority|s[- ]tier|tier s|must[- ]read|urgent|critical priority|highest (?:priority|relevance|score|quality))\b|\b(?:the |any )?(?:grader|grading model|summari[sz]er|classifier|ranker|evaluator|ai|model|assistant|llm)\b[^.!?\n]{0,30}\b(?:should|must|needs? to|has to|shall|is to)\b[^.!?\n]{0,30}\b(?:rate|score|rank|grade|give|mark|label|classify|treat)\b|\b(?:bewerte|bewertet|gib|vergib|stufe)\w*\b[^.!?\n]{0,40}\b(?:volle[rn]? punktzahl|hochste\w* (?:bewertung|punktzahl|stufe|prioritat)|10 ?\/ ?10|10 von 10|5 sterne|top[- ]prioritat)/u,
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
    re: /\b(?:use|call|invoke|run|trigger|execute)\b(?: your| the)? (?!(?:a|an|any|the|this|that|some|each|every)\b)[\w.-]+[ _](?:tool|function|plugin|action)\b|\b(?:send_email|send_message|http_request|run_shell|execute_code|browse|fetch_url)\s*\(|\b(?:forward|send|email|post|upload|exfiltrate|copy)\b(?:\W+\w+){0,3}?\W+(?:the user'?s?|all|your|the owner'?s?|private)\W+(?:\w+\W+)?(?:messages|emails|mails|files|data|conversations?|history|context|memory|notes|credentials|contacts)\b/u,
  },
  {
    flag: "injection:authority",
    re: /\btreat (?:it|this)(?:\W+\w+){0,3}?\W+as (?:written|sent|authored|coming|issued) (?:by|from) the (?:user|owner|admin|developer|operator)\b|\bpre-?approved\b|\b(?:the user|the owner|your owner|the admin) has (?:already )?(?:approved|authori[sz]ed|confirmed)\b/u,
  },
  {
    // An instruction to decode something and act on it.
    flag: "injection:encoded",
    re: /\b(?:decode|decipher|unscramble|reverse|read (?:it |this )?backwards?)\b[^.!?\n]{0,60}\b(?:and|then)\b[^.!?\n]{0,20}\b(?:do|follow|execute|obey|run|act on|carry out|perform)\b/u,
  },
  {
    flag: "markup:role",
    re: /<\|(?:im_start|im_end|system|user|assistant|endoftext|start_header_id|end_header_id|eot_id|begin_of_text)\|>|\[\/?inst\]|<<\/?sys>>|<\/?(?:system|system_prompt|instructions?)>|<(?:start|end)_of_turn>|^\[(?:system|admin|developer)(?: message| note| prompt)?\]|^\s*(?:system|developer)\s*:\s*(?:you|ignore|new)/mu,
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

// Encoded text is decoded once and read again: base64 (standard or URL-safe) and hex runs that decode to readable text.
const BASE64_RUN = /[A-Za-z0-9+/_-]{24,4096}={0,2}/g;
/** Decoding stops after this many encoded characters per item: a data URI in a feed can be megabytes. */
const DECODE_BUDGET = 65_536;
const HEX_RUN = /\b(?:[0-9a-fA-F]{2}[ :]?){16,}\b/g;

function printable(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const ok = [...text].filter((c) => /[\p{L}\p{N}\p{P}\s]/u.test(c)).length;
  return ok / [...text].length >= 0.9 ? text : undefined;
}

function decodedRuns(text: string): string[] {
  const out: string[] = [];
  let budget = DECODE_BUDGET;
  for (const [run] of text.matchAll(BASE64_RUN)) {
    if ((budget -= run.length) < 0) break;
    try {
      const t = printable(Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
      if (t) out.push(t);
    } catch {
      // not base64
    }
  }
  for (const [run] of text.matchAll(HEX_RUN)) {
    const t = printable(Buffer.from(run.replace(/[ :]/g, ""), "hex"));
    if (t) out.push(t);
  }
  return out;
}

/** The signature flags of a text: Latin signatures on the folded copy, the others on the readable one. */
function signatureFlags(text: string): Set<string> {
  const folded = matchingCopy(text);
  const plain = readable(text);
  const out = new Set<string>();
  for (const { flag, re, native } of SIGNATURES) if (re.test(native ? plain : folded)) out.add(flag);
  return out;
}

// Guard flags a source or the PII stage may attach. Anything else under `guard:` is reported as
// `guard:unknown` and counts as suspect: a flag never carries text the item chose.
const PII_LABELS = "person|org|email|phone|iban|bank_account|address|id_number|date_of_birth|username|ip|unchecked";
const KNOWN_GUARD_FLAG = new RegExp(`^(?:hidden-html:(?:css|attribute|aria|class|comment|template)(?::note)?|exfil-html|pii:(?:${PII_LABELS}))$`);

/** Every field of an item a prompt or a memory view can carry, as one text; a URL is also read as words. */
export function itemText(e: { title: string; content: string; author?: string; url?: string; abstract?: string; content_kind?: string; published_at?: string; flags?: string[] }): string {
  let urlWords = "";
  if (e.url) {
    try {
      urlWords = decodeURIComponent(e.url.replace(/\+/g, " "));
    } catch {
      urlWords = e.url;
    }
    urlWords = `${e.url}\n${urlWords.replace(/[-_+./=&?#:%]+/g, " ")}`;
  }
  const plainFlags = (e.flags ?? []).filter((f) => !f.startsWith(GUARD_FLAG));
  return [e.title, e.author, urlWords, e.content_kind, e.published_at, e.abstract, e.content, ...plainFlags].filter((s): s is string => Boolean(s)).join("\n\n");
}

/** The risk of an item: every field it carries, and the guard flags its source attached. */
// Views and rules ask for every item's risk on every run; a stored item never changes, so it is assessed once per process.
const RISK_CACHE = new Map<string, Risk>();

export function riskOf(e: Parameters<typeof itemText>[0]): Risk {
  const text = itemText(e);
  const key = sha256(`${text}\u0000${(e.flags ?? []).join("\u0001")}`);
  const hit = RISK_CACHE.get(key);
  if (hit) return hit;
  const r = assess(text, e.flags ?? []);
  RISK_CACHE.set(key, r);
  return r;
}

/** The risk of a text and the guard flags already on its item. Pure: same input, same answer. Levels only go up. */
export function assess(text: string, itemFlags: readonly string[] = []): Risk {
  const flags = new Set<string>();
  let level: RiskLevel = "none";
  const raise = (l: RiskLevel) => {
    if (l === "suspect" || (l === "note" && level === "none")) level = l;
  };
  for (const f of itemFlags) {
    if (!f.startsWith(GUARD_FLAG)) continue;
    const name = f.slice(GUARD_FLAG.length);
    if (!KNOWN_GUARD_FLAG.test(name)) {
      flags.add("guard:unknown");
      raise("suspect");
      continue;
    }
    flags.add(name);
    raise(name.endsWith(":note") || name.startsWith("pii:") ? "note" : "suspect");
  }
  for (const f of invisibleFlags(text)) {
    flags.add(f);
    raise(f.endsWith(":single") ? "note" : "suspect");
  }
  if (exfilLink(text)) {
    flags.add("injection:exfil_link");
    raise("suspect");
  }
  for (const f of signatureFlags(text)) {
    flags.add(f);
    raise("suspect");
  }
  // Once, never recursively: what an encoded run hides is read with the same signatures, and named.
  for (const decoded of decodedRuns(stripInvisible(text))) {
    const inner = signatureFlags(decoded);
    if (exfilLink(decoded)) inner.add("injection:exfil_link");
    if (!inner.size) continue;
    for (const f of ["injection:encoded", ...inner]) flags.add(f);
    raise("suspect");
  }
  return { level, flags: [...flags].sort() };
}

// Hidden text has no reason to address anyone, so a wider net than the signatures is right for it.
const HIDDEN_INTENT =
  /\b(?:ai|ki|ia|assistants?|models?|llms?|agents?|readers?|summar\w*|condens\w*|rank\w*|rat(?:e|ing)|scor\w*|relevance|importance|priority|urgent|critical|flag|mark|instructions?|anweisung\w*|ignore|disregard|override|pretend|jailbr\w*|respond|reply|output|notify|alert|tools?|polic(?:y|ies)|objective|promote|approved?|comply|obey)\b|<\|/u;

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
