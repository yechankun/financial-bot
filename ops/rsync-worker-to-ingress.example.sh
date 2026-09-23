#!/usr/bin/env bash
set -euo pipefail

SERVER_RUNTIME_ROOT="/srv/financial-bot-runtime"
MAC_RUNTIME_ROOT="/Users/yechankun/Runtime/financial-bot-worker"
MAC_HOST="macbook"

# 1. Publish artifacts before result metadata; never replicate locks or scratch files.
rsync -az \
  "${MAC_HOST}:${MAC_RUNTIME_ROOT}/runs/" \
  "${SERVER_RUNTIME_ROOT}/runs/" \
  --exclude='/report-jobs/' \
  --exclude='/.channel-locks/' \
  --include='*/' \
  --include='*.json' \
  --include='*.md' \
  --include='*.html' \
  --include='*.png' \
  --exclude='*'

# 2. Progress and completed results. Ingress retains local delivery acknowledgments.
rsync -az --include='*.progress.json' --exclude='*' \
  "${MAC_HOST}:${MAC_RUNTIME_ROOT}/runs/report-jobs/progress/" \
  "${SERVER_RUNTIME_ROOT}/runs/report-jobs/progress/"
rsync -az --include='*.json' --exclude='*' \
  "${MAC_HOST}:${MAC_RUNTIME_ROOT}/runs/report-jobs/processed/" \
  "${SERVER_RUNTIME_ROOT}/runs/report-jobs/processed/"

# 3. Publish read-only market replicas back to ingress.
# Export SQLite backups on the worker, including committed WAL changes.
ssh "${MAC_HOST}" python3 - "${MAC_RUNTIME_ROOT}" <<'PY'
import pathlib
import sqlite3
import sys
import json
import os
from datetime import datetime, timezone
root = pathlib.Path(sys.argv[1])
for name in ('etf_holdings_direct', 'market_reference', 'market_read_model'):
    source_path = root / 'data' / f'{name}.sqlite3'
    snapshot_path = root / 'data' / f'{name}.snapshot.sqlite3'
    snapshot_path.unlink(missing_ok=True)
    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    with sqlite3.connect(snapshot_path) as destination:
        source.backup(destination)
    source.close()
read_model = sqlite3.connect(f"file:{root / 'data/market_read_model.sqlite3'}?mode=ro", uri=True)
row = read_model.execute("""
  SELECT p.dataset_version,p.published_at,m.checksum
  FROM published_datasets p JOIN dataset_manifests m USING(dataset_version)
  WHERE p.dataset_name='market'
""").fetchone()
read_model.close()
manifest = {
    'dataset_version': row[0] if row else None,
    'published_at': row[1] if row else None,
    'checksum': row[2] if row else None,
    'snapshot_created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
}
target = root / 'data/market_replica_manifest.json'
temporary = target.with_suffix('.tmp')
temporary.write_text(json.dumps(manifest, sort_keys=True) + '\n')
os.replace(temporary, target)
PY
for name in etf_holdings_direct market_reference market_read_model; do
  rsync -az \
    "${MAC_HOST}:${MAC_RUNTIME_ROOT}/data/${name}.snapshot.sqlite3" \
    "${SERVER_RUNTIME_ROOT}/data/${name}.sqlite3.incoming"
  mv "${SERVER_RUNTIME_ROOT}/data/${name}.sqlite3.incoming" \
    "${SERVER_RUNTIME_ROOT}/data/${name}.sqlite3"
done
rsync -az \
  "${MAC_HOST}:${MAC_RUNTIME_ROOT}/data/market_replica_manifest.json" \
  "${SERVER_RUNTIME_ROOT}/data/market_replica_manifest.json.incoming"
mv "${SERVER_RUNTIME_ROOT}/data/market_replica_manifest.json.incoming" \
  "${SERVER_RUNTIME_ROOT}/data/market_replica_manifest.json"

# 4. Raw documents are immutable/content-addressed; copy new files without deleting history.
for directory in issuer-holdings-raw market-reference-raw; do
  rsync -az --ignore-existing \
    "${MAC_HOST}:${MAC_RUNTIME_ROOT}/data/${directory}/" \
    "${SERVER_RUNTIME_ROOT}/data/${directory}/"
done

# 5. Replicate JSON views, never a live SQLite database or worker lock.
rsync -az \
  --include='*.json' --exclude='*' \
  "${MAC_HOST}:${MAC_RUNTIME_ROOT}/benchmark/" \
  "${SERVER_RUNTIME_ROOT}/benchmark/"
