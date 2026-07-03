#!/usr/bin/env python3
"""Send a short digest email over SMTP.

Reads connection settings from the environment. The password comes from
SMTP_PASS and is never written to disk or logged.
"""

import argparse
import os
import smtplib
from email.message import EmailMessage


def build_message(sender, recipient, subject, body):
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject
    msg.set_content(body)
    return msg


def send(recipient, subject, body):
    host = os.environ.get("SMTP_HOST", "smtp.example.com")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "digest@example.com")
    # Password is pulled from the environment — never hardcoded here.
    password = os.environ["SMTP_PASS"]

    message = build_message(user, recipient, subject, body)

    with smtplib.SMTP(host, port) as server:
        server.starttls()
        server.login(user, password)
        server.send_message(message)
    return True


def main():
    parser = argparse.ArgumentParser(description="Send a digest email.")
    parser.add_argument("--to", required=True)
    parser.add_argument("--subject", default="Daily digest")
    parser.add_argument("--body", default="Nothing to report today.")
    args = parser.parse_args()
    send(args.to, args.subject, args.body)
    print("sent")


if __name__ == "__main__":
    main()
