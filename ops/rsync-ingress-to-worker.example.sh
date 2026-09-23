#!/usr/bin/env bash
set -euo pipefail

SERVER_RUNTIME_ROOT="/srv/financial-bot-runtime"
MAC_RUNTIME_ROOT="/Users/yechankun/Runtime/financial-bot-worker"
MAC_HOST="macbook"

# 1. report jobs created by ingress
rsync -az --ignore-existing \
  --include='*.json' --exclude='*' \
  "${SERVER_RUNTIME_ROOT}/runs/report-jobs/pending/" \
  "${MAC_HOST}:${MAC_RUNTIME_ROOT}/runs/report-jobs/pending/"

# 2. optional app-state snapshot if the worker needs read-only server state
# rsync -az \
#   "${SERVER_RUNTIME_ROOT}/data/app.snapshot.json" \
#   "${MAC_HOST}:${MAC_RUNTIME_ROOT}/data/app.snapshot.json"
