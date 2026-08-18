#!/usr/bin/env bash
# Throwaway E2E cleanup — kill the :3100 dev server, remove throwaway artifacts.
set -e
cd /e/Workslens/workai

echo '=== 1. kill dev server on :3100 ==='
for p in $(netstat -ano 2>/dev/null | grep ':3100' | grep LISTENING | awk '{print $NF}' | sort -u); do
  taskkill //F //PID "$p" 2>/dev/null && echo "killed PID $p" || true
done

echo '=== 2. remove throwaway artifacts ==='
rm -f db/e2e-zt.db db/scratch-migration.db db/custom.db.bak-phase2
rm -f /tmp/wl-e2e-cookies.txt /tmp/wl-e2e-server.log /tmp/wl-*.sql /tmp/wl-*.ts /tmp/wl-*.mjs
rm -f scripts/verify-zt-admin.mjs
echo 'removed throwaway db + temp files'

echo '=== 3. confirm nothing listening on :3100 ==='
netstat -ano 2>/dev/null | grep ':3100' | grep LISTENING || echo 'port 3100 free'

echo '=== 4. db dir state ==='
ls db/ 2>/dev/null

echo 'CLEANUP_DONE'
