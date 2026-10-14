#!/usr/bin/env python3
"""Outbox send engine for GitHub Actions (workflow .github/workflows/outbox.yml).

Python standard library only (smtplib, imaplib); decryption goes through `node outbox/crypt-cli.mjs`,
the same WebCrypto code the editor uses. Logs carry counts and codes, never addresses or secrets.

Actions
  send          one plan: wait until its time, read unsubscribe replies, count the sender's Sent mail
                in the last 24 hours, send at the plan's pace while under the daily cap, save progress
                every 100, and hand over to a fresh run (workflow_dispatch) before the 6-hour job limit.
  test-sender   sign in to SMTP and IMAP, send one test to the sender itself, record ok/failed.

Owner rules (2026-10-14): wake on work (no polling cron: the editor dispatches, a run relays itself);
daily cap = 80% of Google's limit (Workspace 2,000, trial 500) over a rolling 24 hours, counted from the
mailbox itself so mail sent by any other tool counts too.
"""
from __future__ import annotations

import argparse
import email.utils
import html
import imaplib
import json
import os
import re
import smtplib
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from email.message import EmailMessage
from pathlib import Path
from typing import Callable, Iterable

# ---------------------------------------------------------------- rules (pure, mirrors outbox/lib.mjs)

GOOGLE_DAILY = {"workspace": 2000, "trial": 500}
CAP_SHARE = 0.8
FIELD_MAX = 200
SUBJECT_MAX = 200
SAVE_EVERY = 100  # a commit per 100 sends (~33 min at 3 a minute): each commit rebuilds the Pages site
RECOUNT_EVERY = 25  # re-read the Sent count (no commit) so other tools' mail counts toward the cap
RELAY_AFTER_S = 5 * 3600 + 40 * 60  # a run hands over before GitHub's 6-hour job limit
RETRY_LATER_S = 15 * 60
NET_TIMEOUT_S = 30

LINK = re.compile(r"\[([^\]\r\n]{1,500})\]\(([^\s)]{1,2000})\)")
BARE_URL = re.compile(r"https?://[^\s<>\"')\]]+")
PLACEHOLDER = re.compile(r"\{\{\s*([a-z][a-z0-9_]{0,31})\s*(?:\|([^}]{0,100}))?\}\}", re.I)
SAFE_URL = re.compile(r"^(?:https?://[^\s/?#]+[^\s]*|mailto:[^\s]+)$", re.I)
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def daily_cap(tier: str | None) -> int:
    return int(GOOGLE_DAILY.get(tier or "", GOOGLE_DAILY["trial"]) * CAP_SHARE)


def clean_value(v) -> str:
    s = CONTROL.sub(" ", "" if v is None else str(v))
    return re.sub(r"\s+", " ", s).strip()[:FIELD_MAX]


def value_of(vars_: dict, key: str, fallback: str | None) -> str:
    k = key.lower()
    v = vars_.get(k)
    if v is None:
        v = (vars_.get("vars") or {}).get(k)
    s = clean_value(v)
    return s or clean_value(fallback or "")


def fill(text: str, vars_: dict, encode: bool = False) -> str:
    def rep(m):
        v = value_of(vars_, m.group(1), m.group(2))
        return urllib.parse.quote(v, safe="-_.!~*'()") if encode else v

    return PLACEHOLDER.sub(rep, text or "")


def safe_url(u: str) -> str | None:
    return u if SAFE_URL.match(u or "") else None


def escape_html(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")


TOKEN = re.compile(LINK.pattern + "|" + BARE_URL.pattern)


def segments(template: str, vars_: dict) -> list[dict]:
    """Links come from the template only (before values are filled), so a value never becomes a link."""
    src = template or ""
    parts, last = [], 0
    for m in TOKEN.finditer(src):
        if m.start() > last:
            parts.append({"text": fill(src[last:m.start()], vars_)})
        if m.group(1) is not None:
            url = safe_url(fill(m.group(2), vars_, True))
            words = fill(m.group(1), vars_)
            parts.append({"link": url, "words": words} if url else {"text": words})
        else:
            raw = m.group(0)
            clean = re.sub(r"[.,;:!?]+$", "", raw)
            url = safe_url(fill(clean, vars_, True))
            parts.append({"link": url, "words": url} if url else {"text": fill(clean, vars_)})
            if len(clean) < len(raw):
                parts.append({"text": raw[len(clean):]})
        last = m.end()
    if last < len(src):
        parts.append({"text": fill(src[last:], vars_)})
    return parts


def render_plain(template: str, vars_: dict) -> str:
    out = []
    for p in segments(template, vars_):
        if "link" in p:
            out.append(p["link"] if p["words"] == p["link"] else f'{p["words"]} ({p["link"]})')
        else:
            out.append(p["text"])
    return "".join(out)


def render_html(template: str, vars_: dict) -> str:
    inner = "".join(
        f'<a href="{escape_html(p["link"])}">{escape_html(p["words"])}</a>' if "link" in p else escape_html(p["text"])
        for p in segments(template, vars_)
    )
    inner = re.sub(r"\r?\n", "<br>\n", inner)
    return f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">{inner}</div>'


def render_subject(subject: str, vars_: dict) -> str:
    return re.sub(r"[\r\n]+", " ", fill(subject, vars_)).strip()[:SUBJECT_MAX]


def footer_text(site: dict, sender_email: str) -> str:
    return (
        f'\n\n--\n{site["name"]} · {site["postalAddress"]}\n'
        f'To stop these emails, reply "unsubscribe" or [unsubscribe here](mailto:{sender_email}?subject=unsubscribe).'
    )


def render_message(template: dict, recipient: dict, site: dict, sender_email: str) -> dict:
    body = (template.get("body") or "") + footer_text(site, sender_email)
    return {
        "subject": render_subject(template.get("subject") or "", recipient),
        "text": render_plain(body, recipient),
        "html": render_html(body, recipient),
    }


UNSUB = re.compile(r"(unsubscribe|remove me)\b", re.I)


def is_unsubscribe(subject: str, first_text_line: str) -> bool:
    """Our footer asks for a reply "unsubscribe" or a mail with subject "unsubscribe"."""
    s = (subject or "").strip()
    return bool(re.match(r"^(re:\s*)*unsubscribe\b", s, re.I)) or bool(UNSUB.match((first_text_line or "").strip()))


def resume_after_cap(sent_times: list[float], cap: int, now: float) -> float:
    """When the 24-hour window frees one slot: the oldest send that keeps us at the cap, plus 24 hours."""
    window = sorted(t for t in sent_times if t > now - 86400)
    over = len(window) - cap
    if over < 0:
        return now
    return window[over] + 86400 + 60


def message_id(plan_id: str, index: int, sender_email: str) -> str:
    domain = sender_email.split("@", 1)[1]
    return f"<outbox.{plan_id}.{index}@{domain}>"


# ---------------------------------------------------------------- adapters

class Crypt:
    """Envelopes through outbox/crypt-cli.mjs (same code as the browser)."""

    def __init__(self, root: Path):
        self.cli = str(root / "outbox" / "crypt-cli.mjs")

    def open(self, path: Path):
        r = subprocess.run(["node", self.cli, "open", str(path)], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError("decrypt_failed")
        return json.loads(r.stdout)

    def seal(self, path: Path, value) -> None:
        r = subprocess.run(["node", self.cli, "seal", str(path)], input=json.dumps(value), capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError("encrypt_failed")


class Repo:
    """Files under outbox/ and commits back to the branch. Our run is the only writer of its status file;
    shared files (sender index, suppression list) are re-read and re-applied when a push races."""

    def __init__(self, root: Path, git: Callable[..., subprocess.CompletedProcess] | None = None):
        self.root = root
        self.git = git or (lambda *a: subprocess.run(["git", *a], cwd=root, capture_output=True, text=True, timeout=120))

    def path(self, rel: str) -> Path:
        return self.root / rel

    def read_json(self, rel: str, default=None):
        p = self.path(rel)
        return json.loads(p.read_text()) if p.exists() else default

    def write_json(self, rel: str, value) -> None:
        p = self.path(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")

    def commit(self, message: str, apply: Callable[[], list[str]], tries: int = 5) -> bool:
        """apply() writes files and returns their paths. Retried on a racing push, from the branch head."""
        for _ in range(tries):
            self.git("fetch", "--quiet", "origin")
            self.git("reset", "--quiet", "--hard", "origin/" + os.environ.get("OUTBOX_BRANCH", "main"))
            files = apply()
            if not files:
                return True
            self.git("add", "--", *files)
            if self.git("diff", "--cached", "--quiet").returncode == 0:
                return True
            self.git("-c", "user.name=outbox-bot", "-c", "user.email=outbox-bot@users.noreply.github.com", "commit", "--quiet", "-m", message)
            if self.git("push", "--quiet", "origin", "HEAD").returncode == 0:
                return True
            time.sleep(3)
        return False


class Dispatcher:
    """Starts outbox.yml again (a relay). workflow_dispatch from GITHUB_TOKEN does start a new run."""

    def __init__(self, repo: str, token: str, branch: str = "main"):
        self.repo, self.token, self.branch = repo, token, branch

    def send(self, inputs: dict) -> None:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{self.repo}/actions/workflows/outbox.yml/dispatches",
            data=json.dumps({"ref": self.branch, "inputs": inputs}).encode(),
            headers={"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT_S) as r:
            if r.status not in (200, 204):
                raise RuntimeError(f"dispatch_{r.status}")


class Mailbox:
    """Gmail over IMAP (app password): Sent count over 24 hours, sent Message-IDs, unsubscribe replies."""

    def __init__(self, login: str, password: str, factory=None):
        self.imap = (factory or (lambda: imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=NET_TIMEOUT_S)))()
        self.imap.login(login, password)
        self._sent = None

    def sent_folder(self) -> str:
        if self._sent:
            return self._sent
        typ, rows = self.imap.list()
        for row in rows or []:
            line = row.decode() if isinstance(row, bytes) else str(row)
            if "\\Sent" in line:
                m = re.search(r'"([^"]+)"\s*$', line) or re.search(r"(\S+)\s*$", line)
                self._sent = m.group(1)
                return self._sent
        self._sent = "[Gmail]/Sent Mail"
        return self._sent

    def sent_times(self, now: float) -> list[float]:
        """Times of everything this account sent in the last 24 hours (any tool)."""
        self.imap.select('"%s"' % self.sent_folder(), readonly=True)
        since = time.strftime("%d-%b-%Y", time.gmtime(now - 2 * 86400))
        typ, data = self.imap.search(None, "SINCE", since)
        ids = (data[0] or b"").split() if data else []
        out = []
        for i in range(0, len(ids), 500):
            chunk = b",".join(ids[i:i + 500]).decode()
            typ, rows = self.imap.fetch(chunk, "(INTERNALDATE)")
            for row in rows or []:
                raw = row if isinstance(row, bytes) else (row[0] if isinstance(row, tuple) else b"")
                t = imaplib.Internaldate2tuple(raw)
                if t:
                    ts = time.mktime(t)
                    if ts > now - 86400:
                        out.append(ts)
        return out

    def sent_message_ids(self, ids: Iterable[str]) -> set[str]:
        self.imap.select('"%s"' % self.sent_folder(), readonly=True)
        found = set()
        for mid in ids:
            typ, data = self.imap.search(None, "HEADER", "Message-ID", mid)
            if data and data[0]:
                found.add(mid)
        return found

    def unsubscribe_requests(self, since: float) -> set[str]:
        self.imap.select("INBOX", readonly=True)
        day = time.strftime("%d-%b-%Y", time.gmtime(since))
        typ, data = self.imap.search(None, "SINCE", day, "OR", "SUBJECT", "unsubscribe", "BODY", "unsubscribe")
        ids = (data[0] or b"").split() if data else []
        out = set()
        for i in range(0, len(ids), 200):
            chunk = b",".join(ids[i:i + 200]).decode()
            typ, rows = self.imap.fetch(chunk, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)] BODY.PEEK[TEXT]<0.400>)")
            msg_from, subject, text = None, "", ""
            for row in rows or []:
                if not isinstance(row, tuple):
                    continue
                head, payload = row[0].decode(errors="replace"), row[1].decode(errors="replace")
                if "HEADER.FIELDS" in head:
                    m = re.search(r"^From:\s*(.+)$", payload, re.M | re.I)
                    msg_from = email.utils.parseaddr(m.group(1))[1].lower() if m else None
                    s = re.search(r"^Subject:\s*(.+)$", payload, re.M | re.I)
                    subject = s.group(1).strip() if s else ""
                else:
                    text = next((ln for ln in payload.splitlines() if ln.strip()), "")
                    if msg_from and is_unsubscribe(subject, text):
                        out.add(msg_from)
                    msg_from, subject, text = None, "", ""
        return out

    def close(self):
        try:
            self.imap.logout()
        except Exception:
            pass


class PermanentRecipientError(Exception):
    pass


class AuthError(Exception):
    pass


class CapError(Exception):
    pass


class TemporaryError(Exception):
    pass


class Smtp:
    def __init__(self, login: str, password: str, factory=None):
        self.login, self.password = login, password
        self.factory = factory or (lambda: smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=NET_TIMEOUT_S))
        self.conn = None

    def _open(self):
        self.conn = self.factory()
        try:
            self.conn.login(self.login, self.password)
        except smtplib.SMTPAuthenticationError as e:
            raise AuthError("smtp_auth") from e

    def send(self, msg: EmailMessage) -> None:
        for attempt in range(3):
            try:
                if self.conn is None:
                    self._open()
                self.conn.send_message(msg)
                return
            except smtplib.SMTPRecipientsRefused as e:
                raise PermanentRecipientError("recipient_refused") from e
            except smtplib.SMTPResponseException as e:
                text = (e.smtp_error or b"").decode(errors="replace") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
                if e.smtp_code == 550 and "5.4.5" in text:
                    raise CapError("google_daily_limit") from e
                if 500 <= e.smtp_code < 600:
                    raise PermanentRecipientError(f"smtp_{e.smtp_code}") from e
                self.conn = None
            except (smtplib.SMTPServerDisconnected, socket.timeout, OSError):
                self.conn = None
            time.sleep(10 * (attempt + 1))
        raise TemporaryError("smtp_unavailable")

    def close(self):
        if self.conn:
            try:
                self.conn.quit()
            except Exception:
                pass


# ---------------------------------------------------------------- service

SUPPRESSED = "outbox/suppressed.enc"
SENDERS = "outbox/senders/index.json"


@dataclass
class Env:
    root: Path
    repo: Repo
    crypt: Crypt
    now: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep
    dispatcher: Dispatcher | None = None
    smtp_factory: Callable | None = None
    imap_factory: Callable | None = None
    started: float = field(default_factory=time.time)


def log(event: str, **counts) -> None:
    print(json.dumps({"event": event, **counts}, sort_keys=True), flush=True)


def load_sender(env: Env, sender_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9-]{1,48}", sender_id or ""):
        raise ValueError("bad_sender_id")
    creds = env.crypt.open(env.root / f"outbox/senders/{sender_id}.enc")
    index = env.repo.read_json(SENDERS, {"senders": []})
    meta = next((s for s in index["senders"] if s.get("id") == sender_id), None)
    if not meta:
        raise ValueError("sender_unknown")
    if (creds.get("email") or "").lower() != (meta.get("email") or "").lower():
        raise ValueError("sender_mismatch")
    return {**meta, "password": re.sub(r"\s+", "", creds.get("appPassword") or ""), "login": creds.get("login") or meta.get("login") or meta["email"]}


def update_sender(env: Env, sender_id: str, **fields) -> None:
    def apply():
        index = env.repo.read_json(SENDERS, {"senders": []})
        for s in index["senders"]:
            if s.get("id") == sender_id:
                s.update(fields)
        env.repo.write_json(SENDERS, index)
        return [SENDERS]

    env.repo.commit(f"outbox: sender {sender_id} {fields.get('status', 'usage')}", apply)


def merge_suppressed(env: Env, add: set[str], sender_id: str, checked_at: float) -> set[str]:
    """Adds unsubscribes to the encrypted list (re-read on every try, so a racing run's additions stay)."""
    result: set[str] = set()

    def apply():
        p = env.root / SUPPRESSED
        cur = env.crypt.open(p) if p.exists() else {"emails": [], "checked": {}}
        emails = set(cur.get("emails", [])) | add
        checked = {**cur.get("checked", {}), sender_id: checked_at}
        result.clear()
        result.update(emails)
        if emails == set(cur.get("emails", [])) and cur.get("checked", {}).get(sender_id) == checked_at:
            return []
        env.crypt.seal(p, {"emails": sorted(emails), "checked": checked})
        return [SUPPRESSED]

    env.repo.commit(f"outbox: unsubscribes ({len(add)} new)", apply)
    return result


def suppressed_and_last_check(env: Env, sender_id: str) -> tuple[set[str], float]:
    p = env.root / SUPPRESSED
    if not p.exists():
        return set(), 0.0
    cur = env.crypt.open(p)
    return set(cur.get("emails", [])), float(cur.get("checked", {}).get(sender_id, 0))


def build_email(plan: dict, index: int, recipient: dict) -> EmailMessage:
    sender = plan["sender"]
    m = render_message(plan["template"], recipient, plan["site"], sender["email"])
    msg = EmailMessage()
    msg["From"] = email.utils.formataddr((sender.get("name") or "", sender["email"]))
    msg["To"] = recipient["email"]
    msg["Subject"] = m["subject"]
    msg["Date"] = email.utils.formatdate(localtime=False)
    msg["Message-ID"] = message_id(plan["id"], index, sender["email"])
    msg["List-Unsubscribe"] = f"<mailto:{sender['email']}?subject=unsubscribe>"
    msg.set_content(m["text"])
    msg.add_alternative(m["html"], subtype="html")
    return msg


def relay(env: Env, plan_id: str, sender_id: str, status: dict, reason: str) -> None:
    status["relays"] = int(status.get("relays", 0)) + 1
    save_status(env, status)
    log("relay", reason=reason, relays=status["relays"])
    if env.dispatcher:
        env.dispatcher.send({"action": "send", "plan": plan_id, "sender": sender_id})


def save_status(env: Env, status: dict) -> None:
    status["updatedAt"] = int(env.now() * 1000)
    rel = f"outbox/status/{status['id']}.json"

    def apply():
        env.repo.write_json(rel, status)
        return [rel]

    env.repo.commit(f"outbox: plan {status['id']} {status['state']} {status['sent']}/{status['total']}", apply)


def run_send(env: Env, plan_id: str, sender_id: str) -> dict:
    if not re.fullmatch(r"[0-9]{12}-[a-z0-9]{4,12}", plan_id or ""):
        raise ValueError("bad_plan_id")
    plan = env.crypt.open(env.root / f"outbox/plans/{plan_id}.enc")
    if plan.get("id") != plan_id or plan.get("sender", {}).get("id") != sender_id:
        raise ValueError("plan_mismatch")
    recipients = plan["recipients"]
    status = env.repo.read_json(f"outbox/status/{plan_id}.json") or {}
    status = {"id": plan_id, "sender": sender_id, "total": len(recipients), "cursor": 0, "sent": 0, "failed": 0, "skipped": 0,
              "state": "queued", "sendAt": plan["sendAt"], **status}
    if status["state"] in ("done", "cancelled", "failed_auth", "failed_sender"):
        log("nothing_to_do", state=status["state"])
        return status

    # Wait for the start (or the cap window) without polling; hand over before the job limit.
    target = max(plan["sendAt"], status.get("resumeAt") or 0) / 1000
    wait = target - env.now()
    if wait > 0:
        if wait > RELAY_AFTER_S - (env.now() - env.started):
            status["state"] = "waiting"
            save_status(env, status)
            env.sleep(max(0, RELAY_AFTER_S - (env.now() - env.started)))
            relay(env, plan_id, sender_id, status, "waiting")
            return status
        status["state"] = "waiting"
        save_status(env, status)
        env.sleep(wait)

    try:
        sender = load_sender(env, sender_id)
    except Exception as e:
        status["state"] = "failed_sender"
        status["error"] = str(e)[:60]
        save_status(env, status)
        log("sender_failed", reason=status["error"])
        return status
    cap = daily_cap(sender.get("tier"))
    mailbox = Mailbox(sender["login"], sender["password"], env.imap_factory)
    smtp = Smtp(sender["login"], sender["password"], env.smtp_factory)
    try:
        suppressed, last_check = suppressed_and_last_check(env, sender_id)
        found = mailbox.unsubscribe_requests(max(last_check, env.now() - 30 * 86400))
        if found or not last_check:
            suppressed = merge_suppressed(env, found, sender_id, int(env.now()))
        sent_times = mailbox.sent_times(env.now())
        log("start", recipients=len(recipients), cursor=status["cursor"], sent24h=len(sent_times), cap=cap, unsubscribes_new=len(found))

        # A run that stopped mid-batch: anything already in Sent is not sent again.
        window = range(status["cursor"], min(len(recipients), status["cursor"] + SAVE_EVERY))
        already = mailbox.sent_message_ids(message_id(plan_id, i, sender["email"]) for i in window)

        status["state"] = "sending"
        gap = 60.0 / max(1, int(plan.get("pacePerMinute") or 3))
        since_save = 0
        while status["cursor"] < len(recipients):
            if env.now() - env.started > RELAY_AFTER_S:
                save_status(env, status)
                relay(env, plan_id, sender_id, status, "job_time")
                return status
            if len(sent_times) >= cap:
                status["state"] = "waiting_cap"
                status["resumeAt"] = int(resume_after_cap(sent_times, cap, env.now()) * 1000)
                save_status(env, status)
                log("cap_reached", sent24h=len(sent_times), cap=cap)
                relay(env, plan_id, sender_id, status, "cap")
                return status
            i = status["cursor"]
            r = recipients[i]
            mid = message_id(plan_id, i, sender["email"])
            if r["email"].lower() in suppressed:
                status["skipped"] += 1
            elif mid in already:
                status["sent"] += 1
            else:
                try:
                    smtp.send(build_email(plan, i, r))
                    status["sent"] += 1
                    sent_times.append(env.now())
                    env.sleep(gap)
                except PermanentRecipientError:
                    status["failed"] += 1
                except CapError:
                    status["state"] = "waiting_cap"
                    status["resumeAt"] = int((env.now() + 6 * 3600) * 1000)
                    save_status(env, status)
                    relay(env, plan_id, sender_id, status, "google_limit")
                    return status
                except TemporaryError:
                    status["state"] = "retrying"
                    status["resumeAt"] = int((env.now() + RETRY_LATER_S) * 1000)
                    save_status(env, status)
                    relay(env, plan_id, sender_id, status, "smtp_unavailable")
                    return status
            status["cursor"] = i + 1
            since_save += 1
            if since_save % RECOUNT_EVERY == 0:
                sent_times = mailbox.sent_times(env.now())  # the mailbox is the truth (other tools send too)
            if since_save >= SAVE_EVERY:
                since_save = 0
                save_status(env, status)
        status["state"] = "done"
        status.pop("resumeAt", None)
        save_status(env, status)
        log("done", sent=status["sent"], failed=status["failed"], skipped=status["skipped"])
        update_sender(env, sender_id, sent24h=len(sent_times), countedAt=int(env.now() * 1000))
        return status
    except AuthError:
        status["state"] = "failed_auth"
        save_status(env, status)
        update_sender(env, sender_id, status="failed", error="smtp_auth")
        log("auth_failed")
        return status
    finally:
        smtp.close()
        mailbox.close()


def run_test_sender(env: Env, sender_id: str) -> dict:
    try:
        sender = load_sender(env, sender_id)
    except Exception as e:
        update_sender(env, sender_id, status="failed", error=str(e)[:60], testedAt=int(env.now() * 1000))
        return {"ok": False, "error": str(e)}
    try:
        mailbox = Mailbox(sender["login"], sender["password"], env.imap_factory)
        used = len(mailbox.sent_times(env.now()))
        mailbox.close()
        smtp = Smtp(sender["login"], sender["password"], env.smtp_factory)
        msg = EmailMessage()
        msg["From"] = email.utils.formataddr((sender.get("name") or "", sender["email"]))
        msg["To"] = sender["email"]
        msg["Subject"] = "Outbox sender test"
        msg["Date"] = email.utils.formatdate(localtime=False)
        msg.set_content("This address can send from the editor's email sender. No action is needed.")
        smtp.send(msg)
        smtp.close()
    except (AuthError, imaplib.IMAP4.error):
        update_sender(env, sender_id, status="failed", error="sign_in_failed", testedAt=int(env.now() * 1000))
        log("test_failed", reason="sign_in_failed")
        return {"ok": False, "error": "sign_in_failed"}
    except Exception as e:
        code = type(e).__name__
        update_sender(env, sender_id, status="failed", error=code, testedAt=int(env.now() * 1000))
        log("test_failed", reason=code)
        return {"ok": False, "error": code}
    update_sender(env, sender_id, status="ok", error=None, testedAt=int(env.now() * 1000), sent24h=used, countedAt=int(env.now() * 1000))
    log("test_ok", sent24h=used)
    return {"ok": True, "sent24h": used}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["send", "test-sender"])
    ap.add_argument("--plan", default="")
    ap.add_argument("--sender", required=True)
    a = ap.parse_args(argv)
    root = Path(os.environ.get("GITHUB_WORKSPACE") or Path(__file__).resolve().parent.parent)
    token, repo_name = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    env = Env(root=root, repo=Repo(root), crypt=Crypt(root),
              dispatcher=Dispatcher(repo_name, token, os.environ.get("OUTBOX_BRANCH", "main")) if token and repo_name else None)
    if a.action == "test-sender":
        return 0 if run_test_sender(env, a.sender)["ok"] else 1
    status = run_send(env, a.plan, a.sender)
    return 1 if status["state"].startswith("failed") else 0


if __name__ == "__main__":
    sys.exit(main())
