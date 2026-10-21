// Memory defense: nothing reaches a ledger, a model or a sink until secrets are
// replaced by a typed marker and private spans are gone. Broad on purpose: this
// runs at a write boundary, where a false positive costs a word and a miss costs a key.

const SECRET_SHAPES: { label: string; re: RegExp }[] = [
  { label: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: "openai_key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { label: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { label: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { label: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
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
