// Outbox: pure rules for the editor's email sender. No network, no clock of its own, no DOM.
// The same rendering rules live in outbox/send.py; outbox/test/vectors.json keeps the two equal.
//
// Template syntax
//   {{first_name}}            a recipient field (empty when missing)
//   {{first_name|there}}      with a fallback
//   [words](https://...)      the words are the link; placeholders inside the URL are URL-encoded
//   https://...               a bare address becomes a link
// Only http and https links are allowed.

export const LIMITS = Object.freeze({
  recipients: 5000, // one plan
  fieldValue: 200, // characters per recipient field
  fieldKeys: 12, // extra CSV columns kept per recipient
  subject: 200,
  body: 20000,
  templateName: 80,
  senderName: 80,
  emailLength: 254,
});

/** Google Workspace sends 2,000 a day per user (trial accounts 500), counted over a rolling 24 hours. */
export const GOOGLE_DAILY = Object.freeze({ workspace: 2000, trial: 500 });
/** Owner 2026-10-14: send at most 80% of Google's limit. */
export const CAP_SHARE = 0.8;
/** Owner pace (same as Outreach): 3 a minute per sender. */
export const PACE_PER_MINUTE = 3;

export function dailyCap(tier) {
  const limit = GOOGLE_DAILY[tier] ?? GOOGLE_DAILY.trial;
  return Math.floor(limit * CAP_SHARE);
}

// ---------- recipients ----------

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function normalizeEmail(raw) {
  const e = String(raw ?? "").trim().replace(/^mailto:/i, "").toLowerCase();
  if (!e || e.length > LIMITS.emailLength || !EMAIL.test(e)) return null;
  const tld = e.slice(e.lastIndexOf(".") + 1);
  return /^[a-z]{2,}$/.test(tld) ? e : null;
}

function cleanValue(v) {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, LIMITS.fieldValue);
}

function cleanKey(k) {
  const key = String(k ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z][a-z0-9_]{0,31}$/.test(key) ? key : null;
}

const HEADER_ALIASES = {
  email: ["email", "e_mail", "email_address", "mail", "address"],
  first_name: ["first_name", "firstname", "first", "given_name"],
  last_name: ["last_name", "lastname", "last", "surname", "family_name"],
  name: ["name", "full_name", "fullname", "contact", "contact_name"],
};

function aliasOf(key) {
  for (const [canon, list] of Object.entries(HEADER_ALIASES)) if (list.includes(key)) return canon;
  return key;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas or semicolons or tabs. */
export function parseCsv(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [",", ";", "\t"].map((s) => [s, firstLine.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function nameParts(name) {
  const n = cleanValue(name);
  if (!n) return {};
  const [first, ...rest] = n.split(" ");
  return { name: n, first_name: first, ...(rest.length ? { last_name: rest.join(" ") } : {}) };
}

function recipientFrom(email, fields) {
  const r = { email };
  const extra = {};
  let kept = 0;
  for (const [k, v] of Object.entries(fields)) {
    const val = cleanValue(v);
    if (!val || k === "email") continue;
    if (k === "first_name" || k === "last_name" || k === "name") r[k] = val;
    else if (kept < LIMITS.fieldKeys) { extra[k] = val; kept++; }
  }
  if (!r.name && (r.first_name || r.last_name)) r.name = [r.first_name, r.last_name].filter(Boolean).join(" ");
  if (!r.first_name && r.name) Object.assign(r, { ...nameParts(r.name), ...r });
  if (kept) r.vars = extra;
  return r;
}

/**
 * Recipients from typed text and/or file text. Text accepts one per line or separated by commas or
 * semicolons, as `email` or `Name <email>`. A file is CSV with a header that names an email column,
 * or plain text. Duplicates (case-insensitive) keep the first; invalid entries are returned, not kept.
 */
export function parseRecipients({ text = "", fileText = "", fileName = "" } = {}) {
  const out = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;
  let overLimit = 0;
  const add = (emailRaw, fields, raw) => {
    const email = normalizeEmail(emailRaw);
    if (!email) { if (String(raw ?? "").trim()) invalid.push(cleanValue(raw)); return; }
    if (seen.has(email)) { duplicates++; return; }
    if (out.length >= LIMITS.recipients) { overLimit++; return; }
    seen.add(email);
    out.push(recipientFrom(email, fields));
  };
  const addLoose = (token) => {
    const t = token.trim();
    if (!t) return;
    const m = /^(.*?)<([^<>]+)>\s*$/.exec(t);
    if (m) add(m[2], nameParts(m[1].replace(/^["']|["']$/g, "").trim()), t);
    else add(t, {}, t);
  };
  for (const token of String(text).split(/[\n;,]+/)) addLoose(token);

  if (fileText) {
    const isCsv = /\.csv$/i.test(fileName) || /[,;\t]/.test(String(fileText).split(/\r?\n/, 1)[0] ?? "");
    const rows = isCsv ? parseCsv(fileText) : [];
    const header = rows[0]?.map((h) => { const k = cleanKey(h); return k ? aliasOf(k) : null; }) ?? [];
    const emailCol = header.indexOf("email");
    if (isCsv && emailCol >= 0) {
      for (const cells of rows.slice(1)) {
        const fields = {};
        header.forEach((k, i) => { if (k && i !== emailCol) fields[k] = cells[i]; });
        add(cells[emailCol], fields, cells.join(", "));
      }
    } else {
      for (const line of String(fileText).split(/\r?\n/)) for (const token of line.split(/[;,\t]+/)) addLoose(token);
    }
  }
  return { recipients: out, invalid: invalid.slice(0, 200), invalidCount: invalid.length, duplicates, overLimit };
}

// ---------- rendering ----------

const LINK = /\[([^\]\r\n]{1,500})\]\(([^\s)]{1,2000})\)/g;
const BARE_URL = /https?:\/\/[^\s<>"')\]]+/g;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*(?:\|([^}]{0,100}))?\}\}/gi;

function valueOf(vars, key, fallback) {
  const k = key.toLowerCase();
  const v = vars[k] ?? vars.vars?.[k];
  const s = cleanValue(v);
  return s || cleanValue(fallback ?? "");
}

/** Placeholders replaced. `encode` URL-encodes each value (used inside link addresses). */
export function fill(text, vars, encode = false) {
  return String(text ?? "").replace(PLACEHOLDER, (_m, key, fb) => {
    const v = valueOf(vars, key, fb);
    return encode ? encodeURIComponent(v) : v;
  });
}

// http(s) with a host, or mailto. Kept exactly as written (outbox/send.py uses the same pattern).
const SAFE_URL = /^(?:https?:\/\/[^\s/?#]+[^\s]*|mailto:[^\s]+)$/i;

function safeUrl(u) {
  return SAFE_URL.test(String(u ?? "")) ? String(u) : null;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Splits the template (before any value is filled in) into text and link parts: `[words](url)` and
 * bare http(s) addresses written in the template. Recipient values are then filled into text only, so
 * a value can never become a link. Returns [{text} | {link, words}].
 */
export function segments(template, vars) {
  const src = String(template ?? "");
  const token = new RegExp(`${LINK.source}|${BARE_URL.source}`, "g");
  const parts = [];
  let last = 0;
  for (const m of src.matchAll(token)) {
    if (m.index > last) parts.push({ text: fill(src.slice(last, m.index), vars) });
    if (m[1] !== undefined) {
      const url = safeUrl(fill(m[2], vars, true));
      const words = fill(m[1], vars);
      parts.push(url ? { link: url, words } : { text: words });
    } else {
      const raw = m[0];
      const clean = raw.replace(/[.,;:!?]+$/, "");
      const url = safeUrl(fill(clean, vars, true));
      parts.push(url ? { link: url, words: url } : { text: fill(clean, vars) });
      if (clean.length < raw.length) parts.push({ text: raw.slice(clean.length) });
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push({ text: fill(src.slice(last), vars) });
  return parts;
}

/** Plain-text body: a link reads "words (address)", or just the address when they are the same. */
export function renderPlain(template, vars) {
  return segments(template, vars).map((p) => (p.link ? (p.words === p.link ? p.link : `${p.words} (${p.link})`) : p.text)).join("");
}

/** HTML body: escaped text, the template's links as anchors, line breaks kept. */
export function renderHtml(template, vars) {
  const inner = segments(template, vars)
    .map((p) => (p.link ? `<a href="${escapeHtml(p.link)}">${escapeHtml(p.words)}</a>` : escapeHtml(p.text)))
    .join("")
    .replace(/\r?\n/g, "<br>\n");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">${inner}</div>`;
}

export function renderSubject(subject, vars) {
  return fill(subject, vars).replace(/[\r\n]+/g, " ").trim().slice(0, LIMITS.subject);
}

/** The footer every email carries (CAN-SPAM: postal address and a way to stop). */
export function footerText(site, senderEmail) {
  return (
    `\n\n--\n${site.name} · ${site.postalAddress}\n` +
    `To stop these emails, reply "unsubscribe" or [unsubscribe here](mailto:${senderEmail}?subject=unsubscribe).`
  );
}

/** Subject, plain and HTML for one recipient: exactly what the sender will deliver. */
export function renderMessage({ template, recipient, site, senderEmail }) {
  const body = String(template.body ?? "") + footerText(site, senderEmail);
  return {
    subject: renderSubject(template.subject, recipient),
    text: renderPlain(body, recipient),
    html: renderHtml(body, recipient),
  };
}

// ---------- templates ----------

export function validateTemplate(t) {
  const name = cleanValue(t?.name).slice(0, LIMITS.templateName);
  const subject = String(t?.subject ?? "").replace(/[\r\n]+/g, " ").trim();
  const body = String(t?.body ?? "").replace(/\r\n/g, "\n");
  const errors = [];
  if (!name) errors.push("name_required");
  if (!subject) errors.push("subject_required");
  if (subject.length > LIMITS.subject) errors.push("subject_too_long");
  if (!body.trim()) errors.push("body_required");
  if (body.length > LIMITS.body) errors.push("body_too_long");
  for (const m of body.matchAll(LINK)) if (!safeUrl(fill(m[2], {}, true))) errors.push("bad_link:" + m[2].slice(0, 60));
  return { ok: errors.length === 0, errors, template: { name, subject, body } };
}

export function slug(s, max = 40) {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "item";
}

// ---------- time ----------

/** Offset of `tz` at instant `ms`, in minutes east of UTC. */
export function tzOffsetMinutes(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** "2026-10-20" + "09:30" in `tz` → epoch ms. Null when the inputs are not a real date and time. */
export function zonedToUtc(dateStr, timeStr, tz) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ""));
  const t = /^(\d{2}):(\d{2})$/.exec(String(timeStr ?? ""));
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const naive = Date.UTC(y, mo - 1, da, h, mi);
  let ms = naive - tzOffsetMinutes(naive, tz) * 60000;
  ms = naive - tzOffsetMinutes(ms, tz) * 60000; // second pass settles a DST edge
  return ms;
}

export function formatInZone(ms, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

// ---------- plan and script ----------

/**
 * How the sends fall across days: day 1 has the cap minus what the sender already sent in the
 * last 24 hours; later days have the full cap. Pace is PACE_PER_MINUTE.
 */
export function capPlan({ count, cap, used24h = 0 }) {
  const days = [];
  let left = count;
  let room = Math.max(0, cap - Math.max(0, used24h));
  while (left > 0 && days.length < 60) {
    const n = Math.min(left, room);
    days.push(n);
    left -= n;
    room = cap;
  }
  const firstDayRoom = Math.max(0, cap - Math.max(0, used24h));
  return { days, overCap: count > firstDayRoom, firstDayRoom, minutes: Math.ceil(Math.min(count, firstDayRoom || count) / PACE_PER_MINUTE) };
}

export function newPlanId(nowMs, rand) {
  const d = new Date(nowMs).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `${d}-${rand}`;
}

/**
 * Validates everything and returns the plan (what gets encrypted) plus the readable script and
 * warnings. Throws nothing: errors come back in `errors`.
 */
export function buildPlan({ id, now, site, sender, template, recipients, sendAt, timezone, used24h }) {
  const errors = [];
  const warnings = [];
  const t = validateTemplate(template);
  if (!t.ok) errors.push(...t.errors);
  if (!sender || !normalizeEmail(sender.email)) errors.push("sender_required");
  if (!recipients?.length) errors.push("recipients_required");
  if (recipients?.length > LIMITS.recipients) errors.push("too_many_recipients");
  const start = sendAt ?? now;
  if (!Number.isFinite(start)) errors.push("send_time_invalid");
  if (start < now - 60_000) errors.push("send_time_in_past");
  if (start > now + 60 * 86400_000) errors.push("send_time_too_far");
  if (sender && sender.status !== "ok") warnings.push(`Sender ${sender.email} is not tested yet (status: ${sender.status ?? "unknown"}). Run "Test sender" first.`);
  const cap = dailyCap(sender?.tier);
  const cp = capPlan({ count: recipients?.length ?? 0, cap, used24h: used24h ?? 0 });
  if (cp.overCap) {
    warnings.push(
      `Over the daily cap: ${sender?.email} may send ${cap} in 24 hours (80% of Google's ${GOOGLE_DAILY[sender?.tier] ?? GOOGLE_DAILY.trial}); ` +
        `${used24h ?? 0} already sent in the last 24 hours, so ${cp.firstDayRoom} go on day 1 and the rest continue on later days (${cp.days.join(" + ")}).`,
    );
  }
  if (errors.length) return { ok: false, errors, warnings };
  const plan = {
    v: 1,
    id,
    createdAt: now,
    site: { name: site.name, postalAddress: site.postalAddress },
    sender: { id: sender.id, email: sender.email, name: sender.name ?? "", tier: sender.tier ?? "workspace" },
    sendAt: start,
    timezone,
    pacePerMinute: PACE_PER_MINUTE,
    dailyCap: cap,
    template: { id: template.id ?? null, ...t.template },
    recipients,
  };
  const first = renderMessage({ template: t.template, recipient: recipients[0], site, senderEmail: sender.email });
  const hours = Math.floor(cp.minutes / 60);
  const script = [
    `# Send plan ${id}`,
    `From:       ${sender.name ? `${sender.name} <${sender.email}>` : sender.email}`,
    `Template:   ${t.template.name}`,
    `Start:      ${formatInZone(start, timezone)} (${timezone}) = ${new Date(start).toISOString().replace(".000Z", "Z")}`,
    `Recipients: ${recipients.length}`,
    `Pace:       ${PACE_PER_MINUTE} a minute, about ${hours ? `${hours} h ` : ""}${cp.minutes % 60} min for day 1`,
    `Daily cap:  ${cap} in any 24 hours (80% of ${GOOGLE_DAILY[sender.tier] ?? GOOGLE_DAILY.trial}); counted from ${sender.email}'s own Sent mail before each batch`,
    `By day:     ${cp.days.join(" + ")}`,
    ``,
    `Steps (GitHub Actions, workflow outbox.yml, plan ${id}):`,
    `  1. Starts now. Waits until the start time; a wait longer than 5 h 40 min hands over to a fresh run.`,
    `  2. Reads ${sender.email}'s inbox for "unsubscribe" replies and never mails those addresses.`,
    `  3. Counts ${sender.email}'s Sent mail in the last 24 hours and sends only while under ${cap}.`,
    `  4. Sends ${PACE_PER_MINUTE} a minute; saves progress every 100, so a stopped run resumes without sending twice.`,
    `  5. Writes counts only (no addresses) to outbox/status/${id}.json.`,
    ``,
    `Preview, first recipient (${recipients[0].email}):`,
    `Subject: ${first.subject}`,
    ``,
    first.text,
  ].join("\n");
  return { ok: true, plan, script, warnings, errors: [] };
}
