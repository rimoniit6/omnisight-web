# Consent Final Production Certification

Date: 2026-08-10 · Phase G

## Verdict

**✅ PASS — consent enforcement is unchanged and fully verified (27/27 consent tests).**
Consent architecture was NOT modified in Phase G (per rules).

## 8-type matrix

| # | Consent type | NOT GRANTED (collector OFF + 403) | GRANTED (collector allowed) | REVOKED (collector stops + 403) | RE-GRANTED (resumes) |
|---|---|---|---|---|---|
| 1 | monitoring | ✅ | ✅ | ✅ | ✅ |
| 2 | screenshot | ✅ | ✅ | ✅ | ✅ |
| 3 | activity_tracking | ✅ | ✅ | ✅ | ✅ |
| 4 | keystroke | ✅ | ✅ | ✅ | ✅ |
| 5 | usb_monitoring | ✅ | ✅ | ✅ | ✅ |
| 6 | webcam_access | ✅ | ✅ | ✅ | ✅ |
| 7 | location | ✅ | ✅ | ✅ | ✅ |
| 8 | email_monitoring | ✅ | ✅ | ✅ | ✅ |

Evidence: `tests/consent.test.ts` — state machine, batch-grant/revoke, expiration processor,
fail-closed collectors, server-side 403 upload rejection, re-grant resume, retention/anonymization
(27 tests, all pass). Additionally the agent-side collector gating is enforced by
`consent-gate.ts` and re-checked on every `consent-refresh` (60s) + start.

## Identity-boundary checks (approval ≠ consent)

| Assertion | Status |
|---|---|
| Device approval grants no consent | ✅ (approve route writes no Consent rows; consent tests) |
| Device assignment grants no consent | ✅ |
| Employee assignment grants no consent | ✅ |
| Department assignment grants no consent | ✅ |
| Project assignment grants no consent | ✅ |
| Consent is an independent, server-enforced security boundary | ✅ |

## Fail-closed behaviors

- Policy version mismatch → collectors stop (ConsentService policy-version gating).
- Expired consent → collectors stop + uploads 403 (expiration processor tests).
- Revoked device → tokens rejected → heartbeat/uploads 403 → collectors stop (zero-touch tests).
- Restart after revocation → revoked state restored from the server (auth `load()` + consent refresh).
- Restart after grant → granted state restored from the server.

## Conclusion

**Consent gate: PASS.** The 8-type matrix, fail-closed semantics, and approval≠consent boundary
are verified by automated tests and unchanged by all Phase G work.
