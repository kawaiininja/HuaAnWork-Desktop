#!/bin/sh
W=/tmp/a4-precheck
TOKEN=precheck-2026-10-14
cd /Users/amonmiao/Downloads/cursor/agent-catalog-server
AGENT_CATALOG_TOKEN=$TOKEN ENTRIES_DIR=$W/entries HOST=127.0.0.1 PORT=18080 node bin.mjs > $W/catalog.log 2>&1 &
cd "/Users/amonmiao/Downloads/cursor/错别字检测智能体"
AGENT_CATALOG_TOKEN=$TOKEN TYPOGUARD_ALLOWED_ROOT=$W/shared TYPOGUARD_FAKE_RUNNER=1 JOBS_DIR=$W/typo-jobs HOST=127.0.0.1 PORT=18081 .venv/bin/python -m api > $W/typo.log 2>&1 &
cd "/Users/amonmiao/Downloads/cursor/代码审查智能体"
CODE_REVIEW_MOCK=1 AGENT_CATALOG_TOKEN=$TOKEN JOBS_DIR=$W/crw-jobs HOST=127.0.0.1 PORT=18082 node server.mjs > $W/crw.log 2>&1 &
cd "/Users/amonmiao/Downloads/cursor/任务编排智能体"
node test/mock-api.mjs > $W/mock.log 2>&1 &
AGENT_CATALOG_TOKEN=$TOKEN DASHBOARD_TOKEN=dev-token DEMO_API_TOKEN=dummy-token node dist/index.js --config examples/tasks.json --db $W/orch.db --port 8787 > $W/orch.log 2>&1 &
echo "supervisor: 5 services launched, waiting..."
wait
