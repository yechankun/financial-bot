#!/usr/bin/env bash
set -euo pipefail

# Run on the ingress host after configuring these paths for both hosts.
WORKER_HOST="macbook"
WORKER_INTERNAL_ROOT="/Users/yechankun/Code/bots/financial-bot-internal"
WORKER_DATA_DIR="/Users/yechankun/Runtime/financial-bot-worker/data"
INGRESS_INTERNAL_ROOT="/srv/financial-bot/node_modules/financial-bot-internal"
INGRESS_DATA_DIR="/srv/financial-bot-runtime/data"

# SQLite backup includes committed WAL writes. The bundle contains only raw
# files referenced by those backups and is checked before it is published.
snapshot_json=$(ssh "${WORKER_HOST}" python3 \
  "${WORKER_INTERNAL_ROOT}/scripts/etf_replica_v1.py" snapshot \
  --data-dir "${WORKER_DATA_DIR}" \
  --output-root "${WORKER_DATA_DIR}/etf-replica-outgoing")
bundle_path=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["bundle"])' <<<"${snapshot_json}")
version=${bundle_path##*/}
incoming="${INGRESS_DATA_DIR}/etf-replica/incoming/${version}"
mkdir -p "${incoming}"
rsync -az "${WORKER_HOST}:${bundle_path}/" "${incoming}/"

# activate verifies DB checksums, schema and every raw SHA-256 before switching
# the current symlink. On failure the previous replica remains active.
python3 "${INGRESS_INTERNAL_ROOT}/scripts/etf_replica_v1.py" activate \
  --bundle "${incoming}" \
  --destination-root "${INGRESS_DATA_DIR}/etf-replica"

# Point ingress at: ETF_DIRECT_DATA_DIR=${INGRESS_DATA_DIR}/etf-replica/current
