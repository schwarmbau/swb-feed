// A personal-data port with no model and no dependency: contact-shaped data only (e-mail, phone,
// IBAN with its checksum, street address, postcode, birth date, ID numbers named as such). Names are
// a model's job (a PiiPort adapter); what makes an item personal is mostly what this finds.

import type { PiiHit, PiiLabel, PiiPort } from "./types.ts";

export interface PiiSpan {
  label: PiiLabel;
  start: number;
  end: number;
  score: number;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;
// Spelled out against harvesters: "jana (at) mail-test (dot) de", "jana [at] mail-test.de".
const EMAIL_SPELLED = /[\w.+-]+\s*[([{]\s*(?:at|ät|@)\s*[)\]}]\s*[\w-]+(?:\s*(?:[([{]\s*(?:dot|punkt)\s*[)\]}]|\.)\s*[\w-]+)+/gi;
// A leading + or 0 and 8–15 digits in groups: "0391 5550123", "+49 (0)30 1234567", "+44 20 7946 0958".
// Dotted groups of three or more digits ("0151.2345.6789"); a date has a two-digit group, so it never matches.
const PHONE_DOTTED = /(?<![\w.,/-])(?:\+\d{1,3}\.?)?0?\d{2,5}(?:\.\d{3,}){2,}(?![\w/-]|[.,]\d)/g;
const PHONE = /(?<![\w.,/-])(?:\+\d{1,3}[ /-]?(?:\(0\)[ ]?)?\d{1,5}|\(?0\d{2,5}\)?)(?:[ /-]?\d{2,}){1,5}(?![\w/-]|[.,]\d)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/gi;
const STREET =
  /\b[A-ZÄÖÜ][\wäöüß.-]*(?:straße|strasse|str\.|weg|allee|platz|gasse|ring|damm|ufer|chaussee|steig|pfad|markt)\s+\d{1,4}\s?[a-z]?\b|\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St\.|Road|Rd\.|Avenue|Ave\.|Lane|Ln\.|Drive|Way|Close|Court|Place|Square|Boulevard|Blvd\.|Terrace|Gardens)\b/g;
const POSTCODE = /(?<=,\s*)\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+|\b[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}\b/g;
const MONTH = "(?:jan|feb|m[aä]r|apr|ma[iy]|jun|jul|aug|sep|o[ck]t|nov|de[cz])[a-zä]*\\.?";
const DATE = `(?:\\d{1,2}[./-] ?\\d{1,2}[./-] ?\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.? (?:of )?${MONTH} \\d{4}|${MONTH} \\d{1,2},? \\d{4})`;
const BIRTH = new RegExp(`\\b(?:geb\\.|geboren(?: am)?|born(?: on)?|date of birth|d\\.?o\\.?b\\.?|geburtsdatum|geburtstag)\\s*:?\\s*${DATE}`, "gi");
// An ID number is only one when the text says what kind it is: "Steuer-ID", "NHS number", "passport".
const ID_NUMBER =
  /\b(?:steuer-?id|steuer-?identifikationsnummer|steuernummer|(?:personal)?ausweis(?:nummer)?|reisepass(?:nummer)?|sozialversicherungsnummer|versichertennummer|krankenversicherungsnummer|pflegekassennummer|kindergeldnummer|führerschein(?:nummer)?|passport(?: number| no\.?)?|ssn|social security(?: number)?|tax id|utr|national insurance(?: number)?|ni number|nhs number|insurance id|patient number|driving licen[cs]e(?: number)?|licen[cs]e number)\b(?: for \w+| des \w+| \w+s)?\W{0,4}(?:ist |is |:)?\s*[A-Z0-9][A-Z0-9 /-]{4,18}[A-Z0-9]/gi;

/** The ISO 13616 mod-97 check, case-insensitive. */
export function ibanValid(s: string): boolean {
  const v = s.replace(/ /g, "").toUpperCase();
  if (v.length < 15 || v.length > 34) return false;
  const moved = (v.slice(4) + v.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of moved) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

export function contactSpans(text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  const add = (re: RegExp, label: PiiLabel, ok: (m: string) => boolean = () => true) => {
    for (const m of text.matchAll(re)) if (ok(m[0])) out.push({ label, start: m.index!, end: m.index! + m[0].length, score: 1 });
  };
  add(EMAIL, "email");
  add(EMAIL_SPELLED, "email");
  add(IBAN, "iban", ibanValid);
  add(PHONE, "phone", (m) => {
    const digits = m.replace(/\D/g, "").length;
    return digits >= 8 && digits <= 15;
  });
  add(PHONE_DOTTED, "phone", (m) => m.replace(/\D/g, "").length <= 15);
  add(STREET, "address");
  add(POSTCODE, "address");
  add(BIRTH, "date_of_birth");
  add(ID_NUMBER, "id_number");
  // A phone inside an IBAN, an ID or a birth date is part of it, not a second find.
  return out.filter((s) => s.label !== "phone" || !out.some((o) => o !== s && o.label !== "phone" && o.start <= s.start && s.end <= o.end));
}

/**
 * Several ports as one, each limited to the labels it is trusted with: e.g. `contactPii()` for what
 * makes an item personal and a local name model for `person` and `org`, which only flag.
 */
export function combinePii(parts: { port: PiiPort; labels?: PiiLabel[] }[]): PiiPort {
  return {
    name: parts.map((p) => p.port.name).join("+"),
    async detect(text) {
      const best = new Map<PiiLabel, number>();
      for (const { port, labels } of parts)
        for (const h of await port.detect(text)) if (!labels || labels.includes(h.label)) best.set(h.label, Math.max(best.get(h.label) ?? 0, h.score));
      return [...best].map(([label, score]) => ({ label, score }));
    },
  };
}

/** The port: one hit per label found. */
export function contactPii(): PiiPort {
  return {
    name: "contact-shapes",
    async detect(text) {
      return [...new Set(contactSpans(text).map((s) => s.label))].map((label): PiiHit => ({ label, score: 1 }));
    },
  };
}
