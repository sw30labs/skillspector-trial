---
name: clean-skill
description: Sends a short daily digest email over SMTP. Use when the user asks to send a digest, email a summary, or run the daily mail job. Trigger on "send the digest" or "email today's summary".
version: 1.0.0
---

# Clean Skill — Daily Digest Mailer

A small, well-behaved skill that composes a plain-text digest and sends it to the
configured recipient over SMTP. It reads the SMTP password from the environment, so
no secret is ever stored in the skill itself.

## When to use

Use this skill when the user wants to email a short summary or run the daily digest
job. It does one thing: build a message and hand it to an SMTP server.

## How it works

1. Collect the lines the user wants in the digest.
2. Call the helper script `send_digest.py` with the recipient and subject.
3. The helper connects to the SMTP host, authenticates with `SMTP_USER` /
   `SMTP_PASS` from the environment, and sends the message.

## Configuration

Set these environment variables before running:

- `SMTP_HOST` — mail server hostname (defaults to `smtp.example.com`)
- `SMTP_PORT` — port (defaults to 587)
- `SMTP_USER` — login user
- `SMTP_PASS` — login password (never hardcode this)

## Running

Run the helper directly:

```
python send_digest.py --to someone@example.com --subject "Daily digest"
```

See [the helper](send_digest.py) for details. Notes on formatting live in
[notes.md](notes.md).

## Safety notes

This skill only talks to the configured SMTP server and reads its password from the
environment. Keep credentials out of the repository — always supply them via
environment variables at run time.
