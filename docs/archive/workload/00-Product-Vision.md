# WorkLensAI — Product Vision

> **File:** workload/00-Product-Vision.md · **Created:** 2026-08-02
> One-page statement of what we build, for whom, why it matters, and how we measure success. Source of truth for all product decisions (see 01-Roadmap.md).

---

## 1. Elevator Pitch

**WorkLensAI is a self-hosted, AI-powered workforce-intelligence platform sold once on CodeCanyon.** The buyer runs the server on their own infrastructure, installs the Windows Agent on employee machines, and brings their own AI keys. Every byte of employee data — screenshots, activity, prompts — stays inside the buyer's own infrastructure. No subscriptions, no per-seat SaaS pricing, no vendor cloud.

## 2. Problem We Solve

- Employees' activity data currently lives in third-party clouds (Teramind, ActivTrak, Time Doctor) that **charge per user per month, forever**, and force sensitive data off-premises.
- Regulated industries (healthcare, finance, legal, government) **cannot** send monitoring data to SaaS clouds.
- SMBs and agencies resent **recurring cost + tier-gating** of basic features.

**Our answer:** one payment, self-hosted, BYOK AI, zero recurring markup.

## 3. Target Buyers (in priority order)

1. **Privacy-conscious SMBs** (10–100 seats) — law firms, clinics, finance, agencies
2. **IT freelancers & MSPs** — deploy for multiple clients, white-label later
3. **BPO / remote teams** — need accountability + reports
4. **Regulated enterprises** (later phases) — DLP, audit, SSO

## 4. Core Promises (non-negotiable)

| Promise | How we keep it |
|---|---|
| 100% self-hosted | Docker Compose + native install; no vendor telemetry |
| BYOK AI works | OpenAI-compatible gateway uses the buyer's key (ADR-004) |
| No AI markup | Buyer pays their provider directly; we never resell tokens |
| Data stays on-prem | Local storage volume; encryption at rest; no cloud sync |
| One-time price | CodeCanyon license; paid major upgrades (v2/v3) later |

## 5. MVP Definition (what "done" means for v1.0)

A buyer can, in under 30 minutes: deploy via Docker Compose → create admin → install the Windows Agent on a PC → watch real activity, screenshots, and AI summaries appear in the dashboard — **securely**, with no fake data and no known critical vulnerabilities.

## 6. Success Metrics (v1.0 launch)

- **CodeCanyon**: listing approved, 4.5★+ rating target within 90 days
- **Activation**: ≥70% of buyers deploy successfully (support-ticket ratio)
- **Retention**: low refund/chargeback rate; ≥20% of buyers take a paid upgrade
- **Performance**: agent <2% CPU idle; dashboard load <2s at 100 seats

## 7. Non-Goals (explicitly out — see 16-Future-Ideas.md)

Multi-tenancy, hosted SaaS, subscription billing, payroll, GPS/mobile, Kubernetes, Kafka/Redis, plugin marketplace at launch, SSO/SCIM at launch.

---

*Related: 01-Roadmap.md (phases), 09-Architecture-Decisions.md (ADRs), 13-CodeCanyon-Checklist.md (launch gate).*
