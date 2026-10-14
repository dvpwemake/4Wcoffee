// node --test outbox/test   (no dependencies)
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LIMITS, buildPlan, capPlan, dailyCap, normalizeEmail, parseCsv, parseRecipients, renderMessage,
  validateTemplate, zonedToUtc,
} from "../lib.mjs";
import { open, seal } from "../crypto.mjs";

const site = { name: "Fourth Wave Coffee", postalAddress: "7220 Trade St, San Diego, CA 92121" };
const sender = { id: "contact-qualifyhours-com", email: "contact@qualifyhours.com", name: "QualifyHours", tier: "workspace", status: "ok" };
const tpl = { id: "intro", name: "Intro", subject: "Hello {{first_name|there}}", body: "Hi {{first_name|there}}, read [this](https://fourthwavecoffee.org/)." };
const NOW = Date.UTC(2026, 9, 14, 20, 0);

test("vectors: the browser renders every shared case exactly as recorded (send.py checks the same file)", () => {
  const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
  assert.ok(vectors.length >= 12);
  for (const v of vectors) assert.deepEqual(renderMessage(v), v.expect, v.name);
});

test("emails: lower-cased, trimmed, mailto: removed; junk and missing TLDs refused", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(normalizeEmail("mailto:b@x.org"), "b@x.org");
  for (const bad of ["", "a@b", "a b@x.com", "@x.com", "a@x.c0m", "a@-x.com", "x".repeat(250) + "@x.com"]) assert.equal(normalizeEmail(bad), null, bad);
});

test("recipients from text: lines, commas, semicolons and Name <email>; duplicates and invalid reported", () => {
  const r = parseRecipients({ text: "ada@x.com, Bo Lee <BO@x.com>; not-an-email\nada@X.com\n\n" });
  assert.deepEqual(r.recipients.map((x) => x.email), ["ada@x.com", "bo@x.com"]);
  assert.equal(r.recipients[1].first_name, "Bo");
  assert.equal(r.recipients[1].name, "Bo Lee");
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.invalid, ["not-an-email"]);
});

test("recipients from CSV: header aliases, quoted fields, extra columns kept as variables (bounded)", () => {
  const csv = 'E-mail,First Name,Company,"Notes, long"\n"cy@x.com","Cy","Acme, Inc.","said ""hi"""\nbad,Zed,,\n';
  const r = parseRecipients({ fileText: csv, fileName: "list.csv" });
  assert.equal(r.recipients.length, 1);
  assert.deepEqual(r.recipients[0], { email: "cy@x.com", first_name: "Cy", name: "Cy", vars: { company: "Acme, Inc.", notes_long: 'said "hi"' } });
  assert.equal(r.invalidCount, 1);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
});

test("recipients: a plain text file works; the plan limit is enforced and counted", () => {
  const many = Array.from({ length: LIMITS.recipients + 3 }, (_, i) => `p${i}@x.com`).join("\n");
  const r = parseRecipients({ fileText: many, fileName: "list.txt" });
  assert.equal(r.recipients.length, LIMITS.recipients);
  assert.equal(r.overLimit, 3);
});

test("templates: name, subject and body required; only http(s) and mailto links", () => {
  assert.equal(validateTemplate(tpl).ok, true);
  assert.deepEqual(validateTemplate({ name: "", subject: "", body: "" }).errors, ["name_required", "subject_required", "body_required"]);
  assert.match(validateTemplate({ ...tpl, body: "x [a](ftp://x.org) y" }).errors[0], /^bad_link/);
});

test("time: a Pacific date and time becomes the right UTC instant on both sides of DST", () => {
  assert.equal(zonedToUtc("2026-10-20", "09:00", "America/Los_Angeles"), Date.UTC(2026, 9, 20, 16, 0)); // PDT
  assert.equal(zonedToUtc("2026-12-01", "09:00", "America/Los_Angeles"), Date.UTC(2026, 11, 1, 17, 0)); // PST
  assert.equal(zonedToUtc("2026-13-01", "09:00", "America/Los_Angeles"), null);
  assert.equal(zonedToUtc("2026-10-20", "9am", "America/Los_Angeles"), null);
});

test("daily cap: 80% of Google's limit (Workspace 2,000 -> 1,600; trial 500 -> 400); spill to later days", () => {
  assert.equal(dailyCap("workspace"), 1600);
  assert.equal(dailyCap("trial"), 400);
  assert.equal(dailyCap(undefined), 400, "unknown tier is treated as the smaller limit");
  assert.deepEqual(capPlan({ count: 4000, cap: 1600, used24h: 600 }).days, [1000, 1600, 1400]);
  assert.equal(capPlan({ count: 900, cap: 1600, used24h: 600 }).overCap, false);
});

test("buildPlan: warns over the cap and for an untested sender; refuses a past time; the script shows the first email", () => {
  const recipients = parseRecipients({ text: Array.from({ length: 1700 }, (_, i) => `r${i}@x.com`).join("\n") }).recipients;
  const p = buildPlan({ id: "202610142000-ab12", now: NOW, site, sender: { ...sender, status: "untested" }, template: tpl, recipients, sendAt: NOW + 3600_000, timezone: "America/Los_Angeles", used24h: 200 });
  assert.equal(p.ok, true);
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings[0], /not tested/);
  assert.match(p.warnings[1], /Over the daily cap.*1400 go on day 1.*1400 \+ 300/);
  assert.match(p.script, /Daily cap:  1600/);
  assert.match(p.script, /Subject: Hello there/);
  assert.match(p.script, /this \(https:\/\/fourthwavecoffee\.org\/\)/);
  assert.equal(p.plan.recipients.length, 1700);
  const past = buildPlan({ id: "x", now: NOW, site, sender, template: tpl, recipients, sendAt: NOW - 3600_000, timezone: "America/Los_Angeles" });
  assert.deepEqual(past.errors, ["send_time_in_past"]);
  const none = buildPlan({ id: "x", now: NOW, site, sender: null, template: tpl, recipients: [], sendAt: NOW, timezone: "America/Los_Angeles" });
  assert.deepEqual(none.errors, ["sender_required", "recipients_required"]);
});

async function testKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  const pem = (label, buf) => `-----BEGIN ${label}-----\n${Buffer.from(buf).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
  return {
    publicPem: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", kp.publicKey)),
    privatePem: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", kp.privateKey)),
  };
}

test("crypto: the browser's envelope opens only with the private key; nothing readable in the ciphertext", async () => {
  const { publicPem, privatePem } = await testKeyPair();
  const value = { recipients: [{ email: "secret.person@x.com" }], appPassword: "abcd efgh ijkl mnop" };
  const env = await seal(publicPem, value);
  assert.doesNotMatch(env, /secret\.person|abcd/);
  assert.deepEqual(await open(privatePem, env), value);
  const other = await testKeyPair();
  await assert.rejects(open(other.privatePem, env));
});

test("crypto: crypt-cli (what GitHub Actions runs) opens a browser envelope from the private key in env", async () => {
  const { publicPem, privatePem } = await testKeyPair();
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  const file = join(dir, "plan.enc");
  writeFileSync(file, await seal(publicPem, { id: "p1", n: 3 }));
  const cli = new URL("../crypt-cli.mjs", import.meta.url).pathname;
  const out = execFileSync(process.execPath, [cli, "open", file], { env: { ...process.env, OUTBOX_PRIVATE_KEY: privatePem } });
  assert.deepEqual(JSON.parse(out.toString()), { id: "p1", n: 3 });
});
