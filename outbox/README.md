# Outbox: the editor's email sender

Editor → **Email** tab (4wave) or the **✉ Email sender** button (CoC). Pick a sender, add recipients (type them, or upload a `.csv` with an
`email` column, or a `.txt`), pick or edit a template (Save / Save as new), choose **Send now** or a
date and time, press **Generate script**, read it, press **Execute**.

## How it runs

- **GitHub Actions** (`.github/workflows/outbox.yml`, `outbox/send.py`). This repo is public, so the
  minutes are free. There is no schedule: Execute starts the workflow; a run waits until the start
  time and hands over to a fresh run before GitHub's 6-hour limit (owner principle 2026-10-14,
  "wake on work, not on a clock"). Gmail's own scheduled send has no API, so it cannot be used.
- **Pace** 3 a minute. **Daily cap** 80% of Google's limit, per sender, over any 24 hours:
  Workspace 2,000 → 1,600; Workspace trial 500 → 400. Every 25 sends the run counts that
  mailbox's own Sent folder, so mail sent by Outreach or by hand counts too. Over the cap, the rest
  waits and continues automatically; Generate script warns first and Execute needs a tick.
- **Unsubscribe**: every email has the postal address and a "reply unsubscribe" link
  (`List-Unsubscribe: mailto:`). Each run reads the sender's inbox for those replies first and never
  mails those addresses again (`outbox/suppressed.enc`).
- **Resume**: progress is saved (committed) every 100 sends, about every 33 minutes, so the Pages
  site is not rebuilt often. A stopped run checks the sender's Sent mail for the next 100
  Message-IDs before sending, so nobody gets the same email twice.

## Privacy (public repo)

Recipient lists (`outbox/plans/*.enc`), app passwords (`outbox/senders/*.enc`) and the unsubscribe
list are committed **only encrypted**: AES-256-GCM per file, the key wrapped with this repo's RSA
public key (`outbox/public-key.pem`). The private key is only the Actions secret
`OUTBOX_PRIVATE_KEY` (a copy is in the owner's keychain, ledger `AgentHub/secrets/TopSecrete/ADMIN.md`).
`outbox/status/*.json` and the logs hold counts only, never addresses.

## Add a sender

Email tab → **Add sender** and follow the steps on screen: sign in to Google as the sending
account, turn on 2-Step Verification, create an app password, paste the 16 letters, **Save and
test**. For an alias (e.g. pr@hshub.com) enter the Google account that owns it as the sign-in; the
alias must be a verified "Send mail as" address in that Gmail. If App passwords is not offered, a
Workspace admin has turned it off for that account.

## One-time setup (owner)

1. Actions secret `OUTBOX_PRIVATE_KEY` = the PEM from the keychain entry named in the ledger.
2. The editor's fine-grained PAT needs **Contents: read and write** and **Actions: read and write**
   on this repo.

## Tests

```bash
node --test outbox/test/*.test.mjs
python3 -m unittest discover -s outbox/test -p 'test_*.py'
node outbox/test/make-vectors.mjs   # after changing rendering in lib.mjs; send.py must still match
```
