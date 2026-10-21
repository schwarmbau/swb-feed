// A PiiPort on OpenMed's PII token classifiers (DeBERTa, Apache-2.0), run on this machine through
// ONNX Runtime, so personal text never leaves it. The approach is the Schleuse's runner: each word is
// tokenized on its own and labelled by its first sub-token, which keeps exact character offsets.
// One model per language; an item goes to the model of its language, or to every model with `route: "all"`.
//
// Models (download, never commit; the files in each directory: config.json, id2label.json,
// tokenizer.json, tokenizer_config.json, model_int8.onnx):
//   de  OpenMed/OpenMed-PII-German-SuperClinical-Small-44M-v1-onnx-android  @ f6a0d9ab98d09e3d8a723f1ae0ab951da4562caf
//   en  OpenMed/OpenMed-PII-SuperClinical-Small-44M-v1-onnx-android         @ 82f57fcab68125b05f1aa9fdd41319732358311b

import { AutoTokenizer, env } from "@huggingface/transformers";
import * as ort from "onnxruntime-node";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PiiHit, PiiLabel, PiiPort } from "../../src/core/types.ts";

export type Lang = "de" | "en";
export interface Span {
  label: PiiLabel;
  start: number;
  end: number;
  score: number;
}

// Both label sets onto the engine's fixed vocabulary. A label not listed (dates, amounts, cities,
// job titles, passwords: the guard redacts those) is ignored.
const LABELS: Record<string, PiiLabel> = {
  // OpenMed German (ai4privacy labels)
  FIRSTNAME: "person", MIDDLENAME: "person", LASTNAME: "person", ACCOUNTNAME: "username", USERNAME: "username",
  ORGANIZATION: "org", EMAIL: "email", PHONE: "phone", IBAN: "iban", BANKACCOUNT: "bank_account", CREDITCARD: "bank_account",
  STREET: "address", SECONDARYADDRESS: "address", ZIPCODE: "address", DATEOFBIRTH: "date_of_birth", SSN: "id_number", IPADDRESS: "ip",
  // OpenMed English (Nemotron-PII labels)
  first_name: "person", last_name: "person", user_name: "username", company_name: "org", email: "email",
  phone_number: "phone", fax_number: "phone", account_number: "bank_account", bank_routing_number: "bank_account",
  credit_debit_card: "bank_account", swift_bic: "bank_account", street_address: "address", postcode: "address",
  date_of_birth: "date_of_birth", ssn: "id_number", tax_id: "id_number", certificate_license_number: "id_number",
  medical_record_number: "id_number", health_plan_beneficiary_number: "id_number", employee_id: "id_number",
  customer_id: "id_number", ipv4: "ip", ipv6: "ip",
};

const MAX_TOKENS = 400;
const TRAIL = /[\s.,;:!?)\]}"'»«“”„]+$/;
const LEAD = /^[(\[{"'»«“”„]+/;

type Model = { tok: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>; session: ort.InferenceSession; id2label: Record<string, string> };
const loaded = new Map<string, Promise<Model>>();

function load(dir: string): Promise<Model> {
  let m = loaded.get(dir);
  if (!m) {
    m = (async () => {
      env.allowRemoteModels = false;
      env.localModelPath = dirname(dir);
      const tok = await AutoTokenizer.from_pretrained(basename(dir));
      const session = await ort.InferenceSession.create(join(dir, "model_int8.onnx"));
      const id2label = JSON.parse(readFileSync(join(dir, "id2label.json"), "utf8")) as Record<string, string>;
      return { tok, session, id2label };
    })();
    loaded.set(dir, m);
  }
  return m;
}

const GERMAN = /\b(?:der|die|das|und|ist|nicht|mit|für|ich|wir|bitte|auf|den|dem|eine?|auch|sich|noch|wird|sind|vom|zum|zur|bei)\b|[äöüß]/gi;
const ENGLISH = /\b(?:the|and|is|not|with|for|you|we|please|on|of|an?|this|that|are|will|from|at|by|be|have)\b/gi;
export const languageOf = (text: string): Lang => ((text.match(GERMAN)?.length ?? 0) > (text.match(ENGLISH)?.length ?? 0) ? "de" : "en");

/** Labelled spans of one model over a text. */
export async function spans(dir: string, text: string): Promise<Span[]> {
  const { tok, session, id2label } = await load(dir);
  const words: { start: number; end: number; ids: number[] }[] = [];
  // Table cells ("4711;Koch GmbH;…") split on separators, not only on whitespace.
  for (const m of text.matchAll(/[^\s;|\t]+/g)) {
    const ids = tok.encode(m[0], { add_special_tokens: false }) as number[];
    if (ids.length) words.push({ start: m.index!, end: m.index! + m[0].length, ids });
  }
  const tagged: [string, number][] = [];
  for (let i = 0; i < words.length; ) {
    const chunk: typeof words = [];
    let n = 0;
    while (i < words.length && (chunk.length === 0 || n + words[i]!.ids.length <= MAX_TOKENS)) {
      const w = words[i++]!;
      chunk.push(w);
      n += w.ids.length;
    }
    tagged.push(...(await tagChunk(chunk, tok, session, id2label)));
  }
  const out: Span[] = [];
  let cur: { label: PiiLabel; start: number; end: number; p: number[] } | undefined;
  const flush = () => {
    if (!cur) return;
    const slice = text.slice(cur.start, cur.end);
    const lead = slice.match(LEAD)?.[0].length ?? 0;
    const trail = slice.slice(lead).match(TRAIL)?.[0].length ?? 0;
    if (cur.end - trail > cur.start + lead) out.push({ label: cur.label, start: cur.start + lead, end: cur.end - trail, score: Math.min(...cur.p) });
    cur = undefined;
  };
  words.forEach((w, k) => {
    const [lab, p] = tagged[k] ?? ["O", 0];
    const label = LABELS[lab.replace(/^[BI]-/, "")];
    if (!label) return flush();
    // Consecutive words of one label are one span (first name + last name, street + number).
    if (cur && cur.label === label && (lab.startsWith("I-") || /^\s+$/.test(text.slice(cur.end, w.start)))) {
      cur.end = w.end;
      cur.p.push(p);
      return;
    }
    flush();
    cur = { label, start: w.start, end: w.end, p: [p] };
  });
  flush();
  return out;
}

async function tagChunk(chunk: { ids: number[] }[], tok: Model["tok"], session: ort.InferenceSession, id2label: Record<string, string>): Promise<[string, number][]> {
  const special = tok.encode("", { add_special_tokens: true }) as number[];
  const ids: number[] = [special[0] ?? 1];
  const first: number[] = [];
  for (const w of chunk) {
    first.push(ids.length);
    ids.push(...w.ids);
  }
  ids.push(special.at(-1) ?? 2);
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    attention_mask: new ort.Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]),
  };
  if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(ids.length), [1, ids.length]);
  const out = await session.run(feeds);
  const logits = out[session.outputNames[0]!]!;
  const k = logits.dims[2]!;
  const data = logits.data as Float32Array;
  return first.map((pos) => {
    let best = 0;
    let bestV = -Infinity;
    for (let j = 0; j < k; j++) if (data[pos * k + j]! > bestV) (bestV = data[pos * k + j]!), (best = j);
    let sum = 0;
    for (let j = 0; j < k; j++) sum += Math.exp(data[pos * k + j]! - bestV);
    return [id2label[String(best)] ?? "O", 1 / sum];
  });
}

/** The port: one hit per label, at the best span's score. */
export function openmedPii(o: { models: Partial<Record<Lang, string>>; route?: "language" | "all" }): PiiPort {
  const langs = Object.keys(o.models) as Lang[];
  return {
    name: `openmed/${langs.join("+")}${o.route === "all" ? "/all" : ""}`,
    async detect(text) {
      const lang = languageOf(text);
      const dirs = o.route === "all" ? langs.map((l) => o.models[l]!) : [o.models[lang] ?? o.models[langs[0]!]!];
      const best = new Map<PiiLabel, number>();
      for (const dir of dirs) for (const s of await spans(dir, text)) best.set(s.label, Math.max(best.get(s.label) ?? 0, s.score));
      return [...best].map(([label, score]): PiiHit => ({ label, score }));
    },
  };
}
