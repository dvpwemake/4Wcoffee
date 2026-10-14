// Outbox panel: the editor's script-driven email sender.
//   OutboxPanel.mount(root, { repo, branch, getToken, site: { name, postalAddress }, timezone })
// Sender (with an add-sender flow), recipients (typed or a file), template (edit, save, save as new),
// date and time, Generate script, Execute. GitHub Actions does the sending (outbox/send.py).
// All text from data is set with textContent; the email preview renders in a sandboxed frame.

import {
  LIMITS, buildPlan, dailyCap, formatInZone, newPlanId, normalizeEmail, parseRecipients, renderMessage,
  slug, validateTemplate, zonedToUtc, GOOGLE_DAILY,
} from "./lib.mjs";
import { seal } from "./crypto.mjs";
import { GitHubRepo } from "./github.mjs";

const FILE_MAX_BYTES = 2 * 1024 * 1024;
const POLL_MS = 10000;
const POLL_TIMES = 12;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

const CSS = `
.ob{max-width:860px;display:grid;gap:1rem}
.ob section{border:1px solid var(--border,#ccc);padding:1rem;border-radius:6px;background:var(--bg-card,transparent)}
.ob h3{margin:0 0 .6rem;font-size:1rem}
.ob label{display:block;font-size:.8rem;font-weight:600;margin:.55rem 0 .25rem}
.ob input[type=text],.ob input[type=email],.ob input[type=password],.ob input[type=date],.ob input[type=time],.ob select,.ob textarea{width:100%;box-sizing:border-box;padding:.55rem .6rem;font:inherit;border:1px solid var(--border,#bbb);border-radius:4px;background:var(--bg-input,#fff);color:inherit;min-height:44px}
.ob textarea{min-height:8rem;resize:vertical}
.ob .row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.6rem}
.ob button{min-height:44px;padding:0 1rem;font:inherit;border:1px solid var(--border,#999);border-radius:4px;background:transparent;color:inherit;cursor:pointer}
.ob button.pri{background:var(--accent,#c0392b);border-color:var(--accent,#c0392b);color:#fff}
.ob button:disabled{opacity:.5;cursor:not-allowed}
.ob .note{font-size:.85rem;opacity:.8;margin:.35rem 0}
.ob .warn{background:#fff4cc;color:#4a3b00;border-radius:4px;padding:.6rem .7rem;margin:.4rem 0;font-size:.9rem}
.ob .err{background:#fde2e1;color:#6b0f0b;border-radius:4px;padding:.6rem .7rem;margin:.4rem 0;font-size:.9rem}
.ob .ok{color:#1e7b34;font-weight:600}
.ob pre{white-space:pre-wrap;word-break:break-word;font-size:.82rem;background:rgba(127,127,127,.08);padding:.75rem;border-radius:4px;max-height:28rem;overflow:auto}
.ob iframe{width:100%;min-height:16rem;border:1px solid var(--border,#ccc);border-radius:4px;background:#fff}
.ob ol{margin:.3rem 0 .3rem 1.2rem;padding:0}.ob li{margin:.3rem 0}
.ob .two{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
@media (max-width:600px){.ob .two{grid-template-columns:1fr}}
.ob table{width:100%;border-collapse:collapse;font-size:.85rem}.ob td,.ob th{text-align:left;padding:.3rem .4rem;border-bottom:1px solid var(--border,#ddd)}
`;

export class OutboxPanel {
  static mount(root, cfg) {
    const p = new OutboxPanel(root, cfg);
    p.render();
    p.load();
    return p;
  }

  constructor(root, cfg) {
    this.root = root;
    this.cfg = { branch: "main", timezone: "America/Los_Angeles", ...cfg };
    this.senders = [];
    this.templates = [];
    this.publicKey = null;
    this.parsed = { recipients: [], invalid: [], invalidCount: 0, duplicates: 0, overLimit: 0 };
    this.fileText = "";
    this.fileName = "";
    this.result = null;
    this.els = {};
  }

  gh() {
    return new GitHubRepo({ repo: this.cfg.repo, branch: this.cfg.branch, token: this.cfg.getToken() });
  }

  // ---------- layout ----------

  render() {
    if (!document.getElementById("outbox-css")) document.head.append(h("style", { id: "outbox-css" }, CSS));
    const e = this.els;
    e.msg = h("div", { role: "status", "aria-live": "polite" });
    e.sender = h("select", { id: "obSender", onchange: () => this.onSender() });
    e.senderInfo = h("p", { class: "note" });
    e.addForm = h("div", { hidden: true });
    e.text = h("textarea", { id: "obText", placeholder: "ada@example.com\nBo Lee <bo@example.com>", oninput: () => this.onRecipients() });
    e.file = h("input", { type: "file", id: "obFile", accept: ".csv,.txt,text/csv,text/plain", onchange: () => this.onFile() });
    e.recInfo = h("p", { class: "note" });
    e.tplSelect = h("select", { id: "obTpl", onchange: () => this.onTemplate() });
    e.tplName = h("input", { type: "text", id: "obTplName", maxlength: LIMITS.templateName });
    e.tplSubject = h("input", { type: "text", id: "obTplSubject", maxlength: LIMITS.subject, oninput: () => this.preview() });
    e.tplBody = h("textarea", { id: "obTplBody", maxlength: LIMITS.body, oninput: () => this.preview() });
    e.newName = h("input", { type: "text", id: "obNewName", placeholder: "Name for the new template", maxlength: LIMITS.templateName });
    e.preview = h("iframe", { title: "Email preview", sandbox: "" });
    e.when = h("select", { id: "obWhen", onchange: () => this.onWhen() }, h("option", { value: "now" }, "Send now"), h("option", { value: "at" }, "Send at a date and time"));
    e.date = h("input", { type: "date", id: "obDate" });
    e.time = h("input", { type: "time", id: "obTime", value: "09:00" });
    e.whenBox = h("div", { class: "two", hidden: true }, h("div", {}, h("label", { for: "obDate" }, "Date"), e.date), h("div", {}, h("label", { for: "obTime" }, `Time (${this.cfg.timezone})`), e.time));
    e.out = h("div");
    e.ack = h("input", { type: "checkbox", id: "obAck", onchange: () => this.syncExecute() });
    e.ackBox = h("label", { hidden: true }, e.ack, " I read the warnings above and want to send anyway.");
    e.execute = h("button", { type: "button", class: "pri", disabled: true, onclick: () => this.execute() }, "Execute");
    e.status = h("div");

    this.root.replaceChildren(
      h("div", { class: "ob" },
        e.msg,
        h("section", {},
          h("h3", {}, "1. Sender"),
          h("label", { for: "obSender" }, "Send from"),
          e.sender, e.senderInfo,
          h("div", { class: "row" },
            h("button", { type: "button", onclick: () => this.showAddSender() }, "Add sender"),
            h("button", { type: "button", onclick: () => this.testSender() }, "Test sender")),
          e.addForm),
        h("section", {},
          h("h3", {}, "2. Recipients"),
          h("label", { for: "obText" }, "Type or paste addresses (one per line, or separated by commas)"),
          e.text,
          h("label", { for: "obFile" }, "Or upload a file (.csv with an email column, or .txt)"),
          e.file, e.recInfo),
        h("section", {},
          h("h3", {}, "3. Template"),
          h("label", { for: "obTpl" }, "Template"), e.tplSelect,
          h("label", { for: "obTplName" }, "Name"), e.tplName,
          h("label", { for: "obTplSubject" }, "Subject"), e.tplSubject,
          h("label", { for: "obTplBody" }, "Body"), e.tplBody,
          h("p", { class: "note" }, "Placeholders: {{first_name|there}}, {{name}}, {{email}}, or any CSV column. Links: [words](https://...) or a bare https:// address."),
          h("div", { class: "row" }, h("button", { type: "button", onclick: () => this.saveTemplate() }, "Save")),
          h("label", { for: "obNewName" }, "Save as new"),
          h("div", { class: "row" }, e.newName, h("button", { type: "button", onclick: () => this.saveTemplateAsNew() }, "Save as new")),
          h("label", {}, "Preview (first recipient)"), e.preview),
        h("section", {},
          h("h3", {}, "4. When"),
          h("label", { for: "obWhen" }, "Start"), e.when, e.whenBox),
        h("section", {},
          h("h3", {}, "5. Script"),
          h("div", { class: "row" }, h("button", { type: "button", class: "pri", onclick: () => this.generate() }, "Generate script")),
          e.out, e.ackBox,
          h("div", { class: "row" }, e.execute)),
        h("section", {},
          h("h3", {}, "Recent sends"),
          h("div", { class: "row" }, h("button", { type: "button", onclick: () => this.loadStatus() }, "Refresh")),
          e.status)));
    const today = new Date(Date.now() + 86400000);
    e.date.value = today.toISOString().slice(0, 10);
  }

  say(kind, text) {
    this.els.msg.replaceChildren(text ? h("div", { class: kind }, text) : "");
  }

  // ---------- data ----------

  async load() {
    if (!this.cfg.getToken()) {
      this.say("warn", "Unlock the editor with Touch ID (or paste the GitHub token) to use the email sender.");
      return;
    }
    try {
      const gh = this.gh();
      const [idx, key, names] = await Promise.all([gh.readJson("outbox/senders/index.json"), gh.read("outbox/public-key.pem"), gh.list("outbox/templates")]);
      this.senders = idx?.value?.senders ?? [];
      this.sendersSha = idx?.sha;
      this.publicKey = key?.text ?? null;
      const files = names.filter((n) => /^[a-z0-9-]{1,60}\.json$/.test(n)).slice(0, 50);
      this.templates = (await Promise.all(files.map((n) => gh.readJson("outbox/templates/" + n).then((r) => r && { ...r.value, id: n.slice(0, -5), sha: r.sha })))).filter(Boolean);
      this.fillSenders();
      this.fillTemplates();
      if (!this.publicKey) this.say("err", "outbox/public-key.pem is missing in the repo; sending is not set up yet.");
      else this.say("", "");
      this.loadStatus();
    } catch (err) {
      this.say("err", "Could not load the sender data: " + err.message);
    }
  }

  fillSenders(selectId) {
    const sel = this.els.sender;
    const keep = selectId ?? sel.value;
    sel.replaceChildren(...this.senders.map((s) => h("option", { value: s.id }, `${s.name ? s.name + " — " : ""}${s.email}  [${s.status}]`)));
    if (keep && this.senders.some((s) => s.id === keep)) sel.value = keep;
    this.onSender();
  }

  currentSender() {
    return this.senders.find((s) => s.id === this.els.sender.value) ?? null;
  }

  onSender() {
    const s = this.currentSender();
    if (!s) return this.els.senderInfo.replaceChildren("No sender yet. Add one.");
    const cap = dailyCap(s.tier);
    const used = Number.isFinite(s.sent24h) ? `${s.sent24h} sent in the 24 hours before ${s.countedAt ? formatInZone(s.countedAt, this.cfg.timezone) : "?"}` : "usage not counted yet";
    const state = s.status === "ok" ? h("span", { class: "ok" }, "tested ✓") : s.status === "needs_password" ? "needs an app password (Add sender)" : `${s.status}${s.error ? " (" + s.error + ")" : ""}`;
    this.els.senderInfo.replaceChildren(
      `Google ${s.tier === "trial" ? "Workspace trial" : "Workspace"}: daily cap ${cap} (80% of ${GOOGLE_DAILY[s.tier] ?? GOOGLE_DAILY.trial}); ${used}. Status: `, state);
  }

  fillTemplates(selectId) {
    const sel = this.els.tplSelect;
    sel.replaceChildren(h("option", { value: "" }, "— new template —"), ...this.templates.map((t) => h("option", { value: t.id }, t.name)));
    if (selectId) sel.value = selectId;
    else if (this.templates[0] && !sel.value) sel.value = this.templates[0].id;
    this.onTemplate();
  }

  onTemplate() {
    const t = this.templates.find((x) => x.id === this.els.tplSelect.value);
    this.els.tplName.value = t?.name ?? "";
    this.els.tplSubject.value = t?.subject ?? "";
    this.els.tplBody.value = t?.body ?? "";
    this.preview();
  }

  editedTemplate() {
    return { id: this.els.tplSelect.value || null, name: this.els.tplName.value, subject: this.els.tplSubject.value, body: this.els.tplBody.value };
  }

  // ---------- recipients ----------

  async onFile() {
    const f = this.els.file.files?.[0];
    this.fileText = "";
    this.fileName = "";
    if (f) {
      if (f.size > FILE_MAX_BYTES) {
        this.els.file.value = "";
        this.say("err", "That file is over 2 MB. Split it, or keep only the email and name columns.");
      } else {
        this.fileText = await f.text();
        this.fileName = f.name;
      }
    }
    this.onRecipients();
  }

  onRecipients() {
    this.parsed = parseRecipients({ text: this.els.text.value, fileText: this.fileText, fileName: this.fileName });
    const p = this.parsed;
    const bits = [`${p.recipients.length} recipients`];
    if (p.duplicates) bits.push(`${p.duplicates} duplicates merged`);
    if (p.invalidCount) bits.push(`${p.invalidCount} not valid (left out): ${p.invalid.slice(0, 5).join(", ")}${p.invalidCount > 5 ? " …" : ""}`);
    if (p.overLimit) bits.push(`${p.overLimit} over the ${LIMITS.recipients} limit (left out)`);
    this.els.recInfo.replaceChildren(bits.join(" · "));
    this.preview();
  }

  preview() {
    const s = this.currentSender();
    const r = this.parsed.recipients[0] ?? { email: "first.recipient@example.com", first_name: "", name: "" };
    const m = renderMessage({ template: this.editedTemplate(), recipient: r, site: this.cfg.site, senderEmail: s?.email ?? "sender@example.com" });
    this.els.preview.srcdoc = `<!doctype html><meta charset="utf-8"><p style="font:600 14px Arial;margin:8px">Subject: ${m.subject.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])}</p><hr>${m.html}`;
  }

  onWhen() {
    this.els.whenBox.hidden = this.els.when.value !== "at";
  }

  // ---------- templates ----------

  async saveTemplate() {
    const t = this.editedTemplate();
    if (!t.id) return this.saveTemplateAsNew(t.name);
    const v = validateTemplate(t);
    if (!v.ok) return this.say("err", "Template not saved: " + v.errors.join(", "));
    const cur = this.templates.find((x) => x.id === t.id);
    try {
      const r = await this.gh().write(`outbox/templates/${t.id}.json`, JSON.stringify({ ...v.template, updatedAt: Date.now() }, null, 2) + "\n", `outbox: template ${t.id}`, cur?.sha);
      Object.assign(cur, v.template, { sha: r.content.sha });
      this.fillTemplates(t.id);
      this.say("ok", `Saved "${v.template.name}".`);
    } catch (err) {
      this.say("err", err.message.startsWith("github_409") ? "Someone else changed this template. Reload the page and try again." : "Not saved: " + err.message);
    }
  }

  async saveTemplateAsNew(nameHint) {
    const name = (this.els.newName.value || nameHint || "").trim();
    const v = validateTemplate({ ...this.editedTemplate(), name });
    if (!v.ok) return this.say("err", "Template not saved: " + v.errors.join(", "));
    const id = `${slug(name, 40)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 4)}`;
    try {
      const r = await this.gh().write(`outbox/templates/${id}.json`, JSON.stringify({ ...v.template, updatedAt: Date.now() }, null, 2) + "\n", `outbox: new template ${id}`);
      this.templates.push({ ...v.template, id, sha: r.content.sha });
      this.els.newName.value = "";
      this.fillTemplates(id);
      this.say("ok", `Saved as a new template "${v.template.name}".`);
    } catch (err) {
      this.say("err", "Not saved: " + err.message);
    }
  }

  // ---------- senders ----------

  showAddSender(prefill) {
    const s = prefill ?? (this.currentSender()?.status === "needs_password" ? this.currentSender() : null);
    const email = h("input", { type: "email", id: "obNewEmail", value: s?.email ?? "", maxlength: LIMITS.emailLength, autocomplete: "off" });
    const login = h("input", { type: "email", id: "obNewLogin", value: s?.login ?? "", placeholder: "Leave empty when it is the same address", autocomplete: "off" });
    const name = h("input", { type: "text", id: "obNewSenderName", value: s?.name ?? "", maxlength: LIMITS.senderName });
    const tier = h("select", { id: "obNewTier" }, h("option", { value: "workspace" }, "Google Workspace (2,000 a day; cap 1,600)"), h("option", { value: "trial" }, "Google Workspace trial (500 a day; cap 400)"));
    if (s?.tier) tier.value = s.tier;
    const pw = h("input", { type: "password", id: "obNewPw", autocomplete: "new-password", placeholder: "16 letters", maxlength: 40 });
    const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
    this.els.addForm.hidden = false;
    this.els.addForm.replaceChildren(
      h("h3", { style: "margin-top:1rem" }, s ? `App password for ${s.email}` : "Add a sender"),
      h("ol", {},
        h("li", {}, "Sign in to Google as the sending account (for an alias such as pr@hshub.com, the account that owns it)."),
        h("li", {}, "Turn on 2-Step Verification: ", link("https://myaccount.google.com/signinoptions/twosv", "open 2-Step Verification"), "."),
        h("li", {}, "Create an app password named \"Editor email sender\": ", link("https://myaccount.google.com/apppasswords", "open App passwords"), ". If the page says the setting is not available, a Workspace admin has turned app passwords off for this account."),
        h("li", {}, "Copy the 16 letters and paste them below. They are encrypted in this browser; only GitHub Actions can read them."),
        h("li", {}, "Save, then wait for the test email to arrive in that inbox. The sender shows \"tested ✓\" when it works.")),
      h("label", { for: "obNewEmail" }, "From address"), email,
      h("label", { for: "obNewSenderName" }, "Display name"), name,
      h("label", { for: "obNewLogin" }, "Google sign-in, if different (the account that owns an alias)"), login,
      h("label", { for: "obNewTier" }, "Account type"), tier,
      h("label", { for: "obNewPw" }, "App password"), pw,
      h("div", { class: "row" },
        h("button", { type: "button", class: "pri", onclick: () => this.saveSender({ email: email.value, login: login.value, name: name.value, tier: tier.value, pw: pw.value }).then((ok) => { if (ok) pw.value = ""; }) }, "Save and test"),
        h("button", { type: "button", onclick: () => { this.els.addForm.hidden = true; } }, "Cancel")));
  }

  async saveSender({ email, login, name, tier, pw }) {
    const addr = normalizeEmail(email);
    const signIn = login.trim() ? normalizeEmail(login) : addr;
    const password = String(pw).replace(/\s+/g, "");
    if (!addr) return this.say("err", "The From address is not a valid email."), false;
    if (!signIn) return this.say("err", "The Google sign-in is not a valid email."), false;
    if (!/^[a-z]{16}$/i.test(password)) return this.say("err", "An app password is 16 letters (spaces are fine)."), false;
    if (!["workspace", "trial"].includes(tier)) return this.say("err", "Pick the account type."), false;
    if (!this.publicKey) return this.say("err", "outbox/public-key.pem is missing; sending is not set up yet."), false;
    const id = slug(addr.replace("@", "-"), 48);
    try {
      const gh = this.gh();
      const enc = await seal(this.publicKey, { email: addr, login: signIn, appPassword: password });
      const old = await gh.read(`outbox/senders/${id}.enc`);
      await gh.write(`outbox/senders/${id}.enc`, enc + "\n", `outbox: sender ${id} credentials (encrypted)`, old?.sha);
      const idx = await gh.readJson("outbox/senders/index.json");
      const list = (idx?.value?.senders ?? []).filter((x) => x.id !== id);
      list.push({ id, email: addr, login: signIn === addr ? undefined : signIn, name: String(name).trim().slice(0, LIMITS.senderName), tier, status: "untested", addedAt: Date.now() });
      await gh.write("outbox/senders/index.json", JSON.stringify({ senders: list }, null, 2) + "\n", `outbox: sender ${id}`, idx?.sha);
      this.senders = list;
      this.fillSenders(id);
      this.els.addForm.hidden = true;
      await this.testSender(id);
      return true;
    } catch (err) {
      this.say("err", "Sender not saved: " + err.message);
      return false;
    }
  }

  async testSender(idIn) {
    const id = idIn ?? this.currentSender()?.id;
    if (!id) return;
    try {
      await this.gh().dispatch({ action: "test-sender", sender: id, plan: "" });
      this.say("warn", "Testing the sender on GitHub (about a minute). A test email goes to that inbox.");
      for (let i = 0; i < POLL_TIMES; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const idx = await this.gh().readJson("outbox/senders/index.json");
        const s = idx?.value?.senders?.find((x) => x.id === id);
        if (s && s.status !== "untested" && (s.testedAt ?? 0) > Date.now() - 10 * 60000) {
          this.senders = idx.value.senders;
          this.fillSenders(id);
          return this.say(s.status === "ok" ? "ok" : "err", s.status === "ok" ? `${s.email} works ✓` : `${s.email} failed: ${s.error ?? "unknown"}. Check the app password and try again.`);
        }
      }
      this.say("warn", "The test is still running. Press Refresh on Recent sends in a minute, or open " + this.gh().runsUrl());
    } catch (err) {
      this.say("err", "Could not start the test: " + err.message);
    }
  }

  // ---------- script ----------

  generate() {
    this.onRecipients();
    const sender = this.currentSender();
    let sendAt = Date.now();
    if (this.els.when.value === "at") {
      sendAt = zonedToUtc(this.els.date.value, this.els.time.value, this.cfg.timezone);
      if (sendAt === null) return this.show({ ok: false, errors: ["send_time_invalid"], warnings: [] });
    }
    const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).padStart(6, "0").slice(0, 6);
    const now = Date.now();
    this.result = buildPlan({
      id: newPlanId(now, rand),
      now,
      site: this.cfg.site,
      sender,
      template: this.editedTemplate(),
      recipients: this.parsed.recipients,
      sendAt,
      timezone: this.cfg.timezone,
      used24h: sender?.sent24h ?? 0,
    });
    this.show(this.result);
  }

  show(res) {
    const e = this.els;
    const parts = [];
    for (const x of res.errors ?? []) parts.push(h("div", { class: "err" }, "Fix first: " + x.replace(/_/g, " ")));
    for (const w of res.warnings ?? []) parts.push(h("div", { class: "warn" }, "⚠ " + w));
    if (res.ok) parts.push(h("pre", {}, res.script));
    e.out.replaceChildren(...parts);
    e.ack.checked = false;
    e.ackBox.hidden = !(res.ok && res.warnings.length);
    this.syncExecute();
  }

  syncExecute() {
    const r = this.result;
    this.els.execute.disabled = !(r?.ok && (!r.warnings.length || this.els.ack.checked));
  }

  async execute() {
    const r = this.result;
    if (!r?.ok) return;
    if (!this.publicKey) return this.say("err", "outbox/public-key.pem is missing; sending is not set up yet.");
    this.els.execute.disabled = true;
    try {
      const gh = this.gh();
      const plan = r.plan;
      await gh.write(`outbox/plans/${plan.id}.enc`, (await seal(this.publicKey, plan)) + "\n", `outbox: plan ${plan.id} (encrypted)`);
      const status = { id: plan.id, sender: plan.sender.id, total: plan.recipients.length, cursor: 0, sent: 0, failed: 0, skipped: 0, state: "queued", sendAt: plan.sendAt, updatedAt: Date.now() };
      await gh.write(`outbox/status/${plan.id}.json`, JSON.stringify(status, null, 2) + "\n", `outbox: plan ${plan.id} queued`);
      await gh.dispatch({ action: "send", plan: plan.id, sender: plan.sender.id });
      this.result = null;
      this.say("ok", `Plan ${plan.id} is queued: ${plan.recipients.length} emails from ${formatInZone(plan.sendAt, this.cfg.timezone)}. Progress shows under Recent sends.`);
      this.loadStatus();
    } catch (err) {
      this.say("err", "Not started: " + err.message);
      this.els.execute.disabled = false;
    }
  }

  async loadStatus() {
    try {
      const gh = this.gh();
      const names = (await gh.list("outbox/status")).filter((n) => /^\d{12}-[a-z0-9]{4,12}\.json$/.test(n)).sort().reverse().slice(0, 10);
      const rows = (await Promise.all(names.map((n) => gh.readJson("outbox/status/" + n)))).filter(Boolean).map((x) => x.value);
      const senderOf = (id) => this.senders.find((s) => s.id === id)?.email ?? id;
      this.els.status.replaceChildren(rows.length
        ? h("table", {},
            h("tr", {}, h("th", {}, "Plan"), h("th", {}, "From"), h("th", {}, "Start"), h("th", {}, "State"), h("th", {}, "Sent"), h("th", {}, "Failed"), h("th", {}, "Skipped")),
            rows.map((s) => h("tr", {}, h("td", {}, s.id), h("td", {}, senderOf(s.sender)), h("td", {}, formatInZone(s.sendAt, this.cfg.timezone)), h("td", {}, s.state + (s.resumeAt ? ` (resumes ${formatInZone(s.resumeAt, this.cfg.timezone)})` : "")), h("td", {}, `${s.sent}/${s.total}`), h("td", {}, s.failed), h("td", {}, s.skipped))))
        : h("p", { class: "note" }, "Nothing sent yet."));
    } catch (err) {
      this.els.status.replaceChildren(h("p", { class: "note" }, "Could not read the status: " + err.message));
    }
  }
}

globalThis.OutboxPanel = OutboxPanel;
