"""python3 -m unittest discover -s outbox/test -p 'test_*.py'   (standard library only)"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import smtplib
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("outbox_send", HERE.parent / "send.py")
S = importlib.util.module_from_spec(spec)
sys.modules["outbox_send"] = S
spec.loader.exec_module(S)

T0 = 1792008000.0  # 2026-10-14 20:00 UTC


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += max(0, s)


class FakeCrypt:
    """Envelopes as plain JSON files with a marker: the engine's logic, not the cipher, is under test here
    (lib.test.mjs proves the cipher and crypt-cli)."""

    def open(self, path):
        doc = json.loads(Path(path).read_text())
        assert doc.pop("__sealed__") is True
        return doc

    def seal(self, path, value):
        Path(path).write_text(json.dumps({"__sealed__": True, **value}))


class FakeGit:
    def __init__(self):
        self.commits = 0

    def __call__(self, *args):
        if "commit" in args:  # the engine runs `git -c user.name=... commit ...`
            self.commits += 1
        rc = 1 if args[:2] == ("diff", "--cached") else 0
        return subprocess.CompletedProcess(args, rc, "", "")


class FakeImap:
    def __init__(self, mail, password_ok=True):
        self.mail, self.password_ok, self.box = mail, password_ok, None

    def login(self, user, pw):
        if not self.password_ok:
            raise S.imaplib.IMAP4.error("AUTHENTICATIONFAILED")

    def list(self):
        return "OK", [b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"', b'(\\HasNoChildren) "/" "INBOX"']

    def select(self, box, readonly=False):
        self.box = box.strip('"')
        return "OK", [b"1"]

    def search(self, charset, *crit):
        if self.box == "[Gmail]/Sent Mail":
            if crit[0] == "HEADER":
                hit = [str(i + 1) for i, m in enumerate(self.mail.sent) if m["mid"] == crit[2]]
                return "OK", [" ".join(hit).encode()]
            return "OK", [" ".join(str(i + 1) for i in range(len(self.mail.sent))).encode()]
        return "OK", [" ".join(str(i + 1) for i in range(len(self.mail.inbox))).encode()]

    def fetch(self, ids, what):
        out = []
        for i in ids.split(","):
            n = int(i) - 1
            if "INTERNALDATE" in what:
                t = time.strftime("%d-%b-%Y %H:%M:%S +0000", time.gmtime(self.mail.sent[n]["at"]))
                out.append(f'{i} (INTERNALDATE "{t}")'.encode())
            else:
                m = self.mail.inbox[n]
                out.append((f"{i} (BODY[HEADER.FIELDS (FROM SUBJECT)] {{50}}".encode(), f"From: {m['from']}\r\nSubject: {m['subject']}\r\n\r\n".encode()))
                out.append((b" BODY[TEXT]<0> {20}", m["text"].encode()))
                out.append(b")")
        return "OK", out

    def logout(self):
        pass


class FakeSmtp:
    def __init__(self, mail, auth_ok=True, refuse=()):
        self.mail, self.auth_ok, self.refuse = mail, auth_ok, set(refuse)

    def login(self, u, p):
        if not self.auth_ok:
            raise smtplib.SMTPAuthenticationError(535, b"5.7.8 bad credentials")

    def send_message(self, msg):
        if msg["To"] in self.refuse:
            raise smtplib.SMTPRecipientsRefused({msg["To"]: (550, b"5.1.1 no such user")})
        self.mail.sent.append({"to": msg["To"], "mid": msg["Message-ID"], "at": self.mail.clock.now(), "msg": msg})

    def quit(self):
        pass


class Gmail:
    def __init__(self, clock):
        self.clock, self.sent, self.inbox = clock, [], []


_WORLDS = []


def tearDownModule():
    for w in _WORLDS:
        w.tmp.cleanup()


class World:
    def __init__(self, n=5, used24h=0, tier="workspace", send_in=0, **smtp_kw):
        self.tmp = tempfile.TemporaryDirectory()
        _WORLDS.append(self)
        self.root = Path(self.tmp.name)
        self.clock = Clock()
        self.gmail = Gmail(self.clock)
        for k in range(used24h):
            self.gmail.sent.append({"to": "old@x.com", "mid": f"<old{k}>", "at": T0 - 3600 - k})
        self.crypt = FakeCrypt()
        self.git = FakeGit()
        self.dispatched = []
        (self.root / "outbox/senders").mkdir(parents=True)
        (self.root / "outbox/plans").mkdir()
        self.crypt.seal(self.root / "outbox/senders/qh.enc", {"email": "contact@qualifyhours.com", "appPassword": "abcd efgh ijkl mnop"})
        (self.root / "outbox/senders/index.json").write_text(json.dumps({"senders": [{"id": "qh", "email": "contact@qualifyhours.com", "name": "QH", "tier": tier, "status": "ok"}]}))
        self.plan_id = "202610142000-ab12"
        self.recipients = [{"email": f"r{i}@x.com", "first_name": f"R{i}"} for i in range(n)]
        self.crypt.seal(self.root / f"outbox/plans/{self.plan_id}.enc", {
            "v": 1, "id": self.plan_id, "sender": {"id": "qh", "email": "contact@qualifyhours.com", "name": "QH", "tier": tier},
            "site": {"name": "Fourth Wave Coffee", "postalAddress": "7220 Trade St, San Diego, CA 92121"},
            "sendAt": int((T0 + send_in) * 1000), "pacePerMinute": 3,
            "template": {"name": "t", "subject": "Hi {{first_name|there}}", "body": "Read [this](https://x.org/a)."},
            "recipients": self.recipients,
        })
        smtp_kw.setdefault("auth_ok", True)
        self.imap_ok = smtp_kw.pop("imap_ok", True)
        self.smtp_kw = smtp_kw

    def env(self):
        return S.Env(
            root=self.root, repo=S.Repo(self.root, self.git), crypt=self.crypt, now=self.clock.now, sleep=self.clock.sleep,
            dispatcher=type("D", (), {"send": lambda _s, inputs: self.dispatched.append(inputs)})(),
            smtp_factory=lambda: FakeSmtp(self.gmail, **self.smtp_kw), imap_factory=lambda: FakeImap(self.gmail, self.imap_ok),
            started=self.clock.now(),
        )

    def status(self):
        return json.loads((self.root / f"outbox/status/{self.plan_id}.json").read_text())

    def run(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            st = S.run_send(self.env(), self.plan_id, "qh")
        self.log = buf.getvalue()
        return st


class Rules(unittest.TestCase):
    def test_vectors_match_the_browser(self):
        for v in json.loads((HERE / "vectors.json").read_text()):
            self.assertEqual(S.render_message(v["template"], v["recipient"], v["site"], v["senderEmail"]), v["expect"], v["name"])

    def test_daily_cap_is_80_percent(self):
        self.assertEqual(S.daily_cap("workspace"), 1600)
        self.assertEqual(S.daily_cap("trial"), 400)

    def test_unsubscribe_words(self):
        self.assertTrue(S.is_unsubscribe("unsubscribe", ""))
        self.assertTrue(S.is_unsubscribe("Re: unsubscribe", ""))
        self.assertTrue(S.is_unsubscribe("Re: hello", "Unsubscribe please"))
        self.assertTrue(S.is_unsubscribe("Re: hello", "remove me"))
        self.assertFalse(S.is_unsubscribe("Re: hello", "Stop by our cafe on Friday"))
        self.assertFalse(S.is_unsubscribe("Re: hello", "Thanks! Do not unsubscribe me"))

    def test_resume_after_cap_is_when_the_window_frees_a_slot(self):
        times = [T0 - 80000 + i for i in range(5)]
        self.assertEqual(S.resume_after_cap(times, 5, T0), times[0] + 86400 + 60)
        self.assertEqual(S.resume_after_cap(times, 9, T0), T0)


class Engine(unittest.TestCase):
    def test_sends_every_recipient_at_the_pace_and_finishes(self):
        w = World(n=30)
        st = w.run()
        self.assertEqual((st["state"], st["sent"], st["cursor"]), ("done", 30, 30))
        self.assertEqual(len(w.gmail.sent), 30)
        first = w.gmail.sent[0]["msg"]
        self.assertEqual(first["Subject"], "Hi R0")
        self.assertEqual(first["List-Unsubscribe"], "<mailto:contact@qualifyhours.com?subject=unsubscribe>")
        self.assertIn("7220 Trade St", first.get_body(("plain",)).get_content())
        self.assertIn('<a href="https://x.org/a">this</a>', first.get_body(("html",)).get_content())
        self.assertGreaterEqual(w.clock.now() - T0, 29 * 20, "3 a minute")
        self.assertNotIn("@", w.log, "logs carry counts only")
        self.assertNotIn("@", json.dumps(w.status()), "status file carries counts only")

    def test_commits_stay_few_so_the_pages_site_is_not_rebuilt_often(self):
        w = World(n=250)
        st = w.run()
        self.assertEqual((st["state"], st["sent"]), ("done", 250))
        # unsubscribe list, progress at 100 and 200, done, sender usage: each commit rebuilds Pages
        self.assertLessEqual(w.git.commits, 6)

    def test_stops_at_the_80_percent_cap_counted_from_the_mailbox_and_relays(self):
        w = World(n=10, used24h=1597)
        st = w.run()
        self.assertEqual((st["state"], st["sent"]), ("waiting_cap", 3))
        self.assertGreater(st["resumeAt"], T0 * 1000)
        self.assertEqual(w.dispatched, [{"action": "send", "plan": w.plan_id, "sender": "qh"}])

    def test_trial_sender_cap_is_400(self):
        w = World(n=5, used24h=398, tier="trial")
        self.assertEqual(w.run()["sent"], 2)

    def test_unsubscribe_reply_is_suppressed_and_kept_encrypted(self):
        w = World(n=3)
        w.gmail.inbox.append({"from": "R1 <r1@x.com>", "subject": "Re: Hi R1", "text": "unsubscribe"})
        st = w.run()
        self.assertEqual((st["sent"], st["skipped"]), (2, 1))
        self.assertNotIn("r1@x.com", [m["to"] for m in w.gmail.sent])
        self.assertIn("r1@x.com", w.crypt.open(w.root / "outbox/suppressed.enc")["emails"])

    def test_a_resumed_run_does_not_send_twice(self):
        w = World(n=5)
        mid = S.message_id(w.plan_id, 2, "contact@qualifyhours.com")
        w.gmail.sent.append({"to": "r2@x.com", "mid": mid, "at": T0 - 60})
        (w.root / "outbox/status").mkdir()
        (w.root / f"outbox/status/{w.plan_id}.json").write_text(json.dumps({"id": w.plan_id, "cursor": 2, "sent": 2, "total": 5, "state": "sending"}))
        st = w.run()
        self.assertEqual((st["state"], st["sent"]), ("done", 5))
        self.assertEqual([m["to"] for m in w.gmail.sent if m["mid"].startswith("<outbox")], ["r2@x.com", "r3@x.com", "r4@x.com"])

    def test_a_far_send_time_waits_then_hands_over_without_sending(self):
        w = World(n=2, send_in=20 * 3600)
        st = w.run()
        self.assertEqual(st["state"], "waiting")
        self.assertEqual(w.gmail.sent, [])
        self.assertEqual(len(w.dispatched), 1)
        self.assertLessEqual(w.clock.now() - T0, S.RELAY_AFTER_S)

    def test_a_refused_recipient_is_counted_and_the_rest_still_go(self):
        w = World(n=3, refuse={"r1@x.com"})
        st = w.run()
        self.assertEqual((st["state"], st["sent"], st["failed"]), ("done", 2, 1))

    def test_bad_password_stops_the_plan_and_marks_the_sender(self):
        w = World(n=3, auth_ok=False)
        st = w.run()
        self.assertEqual(st["state"], "failed_auth")
        idx = json.loads((w.root / "outbox/senders/index.json").read_text())
        self.assertEqual(idx["senders"][0]["status"], "failed")

    def test_a_finished_plan_does_nothing(self):
        w = World(n=3)
        w.run()
        before = len(w.gmail.sent)
        self.assertEqual(w.run()["state"], "done")
        self.assertEqual(len(w.gmail.sent), before)

    def test_wrong_plan_id_shape_is_refused(self):
        w = World(n=1)
        with self.assertRaises(ValueError):
            S.run_send(w.env(), "../../etc", "qh")


class SenderTest(unittest.TestCase):
    def test_ok_records_status_and_usage(self):
        w = World(n=0, used24h=12)
        with contextlib.redirect_stdout(io.StringIO()):
            r = S.run_test_sender(w.env(), "qh")
        self.assertTrue(r["ok"])
        s = json.loads((w.root / "outbox/senders/index.json").read_text())["senders"][0]
        self.assertEqual((s["status"], s["sent24h"]), ("ok", 12))
        self.assertEqual(w.gmail.sent[-1]["to"], "contact@qualifyhours.com")

    def test_bad_password_is_reported(self):
        w = World(n=0, imap_ok=False)
        with contextlib.redirect_stdout(io.StringIO()):
            r = S.run_test_sender(w.env(), "qh")
        self.assertEqual(r, {"ok": False, "error": "sign_in_failed"})


if __name__ == "__main__":
    unittest.main()
