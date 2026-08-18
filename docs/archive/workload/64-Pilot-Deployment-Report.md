# Pilot Deployment Report

Date: 2026-08-10 · Phase G

## Verdict

**🔒 NOT EXECUTED — no test machines are available in this environment.**
The pilot is a **mandatory gate for PRODUCTION READY** and cannot be truthfully reported here.
This document provides the executable pilot plan and the monitoring template to use.

## 1. Pilot plan

| Item | Value |
|---|---|
| Fleet size | 1–5 real Windows machines (mixed: desktop + laptop) |
| Duration | Minimum 24 hours continuous |
| Agent version | v1.1.0 (`out/WorkLensAI Agent Setup 1.1.0.exe`, SHA-256 `d57575c4…`) |
| Server | Production-like admin deployment (PostgreSQL after B-01, HTTPS after B-05) |
| Selection | Consenting employees; activity + screenshot consent granted per policy |

## 2. Pre-pilot checks

- [ ] Clean-machine certification executed (B-02)
- [ ] Installer signed or SmartScreen exception documented (B-03)
- [ ] PostgreSQL live (B-01)
- [ ] HTTPS live (B-05)

## 3. Pilot monitoring template (24h)

| Metric | Method | Alert |
|---|---|---|
| Crashes / process exits | Windows Event Log + agent logs | any |
| CPU / RAM | Task Manager sampling (3×/day) + agent `getStatus` | sustained >40% CPU |
| Network usage | per-machine bandwidth counters | abnormal spikes |
| Heartbeat continuity | Admin devices page `lastHeartbeat` | gap > 3× interval |
| Activity + screenshot uploads | Admin views + server logs | gaps after active periods |
| Consent transitions | consent logs + collector states | any unexpected stop |
| Offline queue growth | agent status `queueLength` | queue > 100 pending |
| Reconnect behavior | agent logs after network blips | reconnect failures |
| Admin assignment changes | change one project → verify propagation | stale assignment |
| Device revoke | revoke → verify fail-closed | any successful upload post-revoke |
| Windows restart | reboot machine → auto-start, same identity | duplicate device/claim |

## 4. Post-pilot report template

- Machine count / hours / OS versions
- Total agent uptime; crash count
- CPU/RAM/network summary (min/avg/max)
- Heartbeat success rate; upload success rate
- Consent transitions observed; any enforcement violations
- Offline/reconnect events and recovery
- Reboot outcomes (identity preserved)
- Findings + fixes; recommendation to proceed or extend

## 5. Conclusion

Pilot not run (no hardware). Plan + template provided. **Pilot gate: NOT VERIFIED** — final
certification (workload/66) reflects this.
