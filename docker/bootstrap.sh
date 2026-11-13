#!/bin/sh
# Entrypoint of the n8n container in docker-compose.yml.
# First start only: create the credential from the environment, import and
# publish the three workflows, then call the setup webhook once n8n is up so
# the data table exists. Later starts leave your edits alone.
set -eu

MARK=/home/node/.n8n/.unknown-write-imported

if [ -f "$MARK" ]; then
  exec n8n start
fi

STAGE=$(mktemp -d)
node /bootstrap/prepare.mjs /bootstrap/workflows "$STAGE"
n8n import:credentials --input="$STAGE/credentials.json"
n8n import:workflow --separate --input="$STAGE/workflows"
for id in unknownWriteSetup1 unknownWriteSubmit unknownWriteCheck1; do
  n8n publish:workflow --id="$id"
done
rm -rf "$STAGE"

n8n start &
N8N=$!
trap 'kill -TERM "$N8N" 2>/dev/null' TERM INT

# Data tables can only be created by a running n8n, so the table is made
# through the setup workflow's webhook.
tries=0
until wget -q -O /dev/null --header="X-Workflow-Key: $WORKFLOW_KEY" --header="Content-Type: application/json" \
  --post-data='{}' http://127.0.0.1:5678/webhook/unknown-write/setup 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 90 ] || ! kill -0 "$N8N" 2>/dev/null; then
    echo "unknown-write: could not create the data table" >&2
    kill -TERM "$N8N" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done
touch "$MARK"
echo "unknown-write: workflows published and data table created"

wait "$N8N"
