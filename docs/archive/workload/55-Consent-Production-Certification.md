# Consent — Final Production Certification

> Date: 2026-08-10
> Verdict: **PASS — 27/27 consent tests + 29/29 zero-touch tests (PostgreSQL)**
> Semantics: **unchanged** — consent is a separate, explicit, server-enforced security boundary. Approval/assignment/activation NEVER grants consent.

---

## 1. The 8 Consent Types (independent)

`monitoring`, `screenshot`, `activity_tracking`, `keystroke`, `usb_monitoring`, `webcam_access`, `location`, `email_monitoring`

## 2. Consent Matrix (all 8 types, executed against PostgreSQL)

| Scenario | Expected | Result | Evidence |
|---|---|---|---|
| Approval of new device | 0 consent rows, all 8 inactive | ✅ | ZT-9 (consent count = 0), ZT-10 (pre-existing pending untouched) |
| No consent → activity upload | collector OFF, server **403**, nothing persisted | ✅ | ZT-21 (403, 0 rows) |
| No consent → screenshot upload | collector OFF, server **403**, nothing persisted | ✅ | ZT-23 (403, 0 rows) |
| Grant activity_tracking | upload **200**, row persisted | ✅ | ZT-22 |
| Revoke activity_tracking | collector stops, upload **403**, nothing new | ✅ | ZT-22 (row count frozen at 1) |
| Re-grant activity_tracking | upload **200** again | ✅ | ZT-22 (cycle repeated) |
| Grant screenshot | upload **200**, file + row persisted | ✅ | ZT-23 |
| Revoke screenshot | collector stops, upload **403** | ✅ | ZT-23 |
| Re-grant screenshot | collector resumes | ✅ | ZT-23 (cycle) |
| Activity consent does NOT imply screenshot | screenshot still **403** | ✅ | ZT-24 |
| Policy version change | old consent invalid; new policy required | ✅ | consent.test (v1→v2→re-consent) |
| Expired consent | fail closed | ✅ | consent.test (expiry processor + lazy) |
| Concurrent consent transitions | exactly one winner, no false audit | ✅ | consent.test |
| Idempotent repeat transitions | no duplicate audit | ✅ | consent.test |
| Immutable audit trail | ConsentLog FK RESTRICT — cannot delete history | ✅ | consent.test + migration-verify |
| Approval ≠ consent | device approval alone enables nothing | ✅ | ZT-9, ZT-10 |

**Full matrix count:** 27/27 consent tests PASS, 29/29 zero-touch tests PASS (which include the route-level 403 enforcement), all on PostgreSQL.

## 3. Server-Side Enforcement (independent of agent behavior)

- `/api/agent/activity` and `/api/agent/screenshot` call `hasActiveConsent()` and return **403** + persist nothing without active consent (verified at route level, not just collector logic).
- Policy version is bound to each grant; a version bump invalidates older grants (fail closed).
- Revoked device → token rejected → all uploads fail closed (ZT-16).
- Approval writes zero consent rows (server-side; verified by DB count, not UI).

## 4. Certifications That Must NOT Grant Consent (verified)

- Device approval → ZT-9 ✅
- Device assignment (employee/department/project) → ZT-9/10 ✅
- Employee assignment → covered by ZT-9 (approve binds employee, 0 consent) ✅
- Agent activation → covered ✅

## 5. Conclusion

**CONSENT PRODUCTION CERTIFICATION: PASS.** The consent boundary is independently enforced on the server, fail-closed on the agent, immutable in audit, and unaffected by the PostgreSQL migration (all matrices executed against PG).
