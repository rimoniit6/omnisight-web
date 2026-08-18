# WorkLensAI — CodeCanyon Release Checklist

> **File:** workload/13-CodeCanyon-Checklist.md · **Created:** 2026-08-02
> The launch gate for the v1.0 CodeCanyon listing. Envato requirements + conversion best practices.

**Target listing:** WorkLensAI — Self-Hosted AI Workforce Intelligence Platform · **Category:** Web Apps / Enterprise

---

## Documentation

- [ ] Complete buyer-facing docs pack: `docs/` PDF or hosted — install, admin, agent, AI, FAQ
- [ ] Docs reference the **shipped** features only (no aspirational claims)
- [ ] Version + changelog linked from docs
- [ ] Video walkthrough (2–5 min) of install → agent → dashboard

## Installation Guide

- [ ] Step-by-step Docker Compose install verified from scratch on Ubuntu 22.04
- [ ] Native install path documented (Node 20+, SQLite)
- [ ] Windows Agent install: MSI + EXE, group-policy rollout, server-URL config
- [ ] Troubleshooting: ports, permissions, AV exceptions, Docker Desktop on Windows
- [ ] Minimum requirements documented (2 vCPU / 2 GB RAM / 10 GB disk)

## Demo Credentials

- [ ] Demo admin credentials provided (and password-change enforced on first login)
- [ ] Demo data (6 orgs / 36 users) clearly labeled as sample data
- [ ] Instructions to reset to demo state after evaluation

## Screenshots

- [ ] 8+ screenshots covering: login, dashboard, analytics, activity timeline, devices, employee profile, screenshots viewer, AI insights
- [ ] All screenshots show **real-looking, non-sensitive** demo data
- [ ] Resolution ≥ 1280px wide; consistent dark theme
- [ ] No confidential info, no localhost URLs, no console windows

## Preview Images

- [ ] Main preview image (1200×640 or Envato-spec) — product UI hero
- [ ] Alt previews for the listing gallery
- [ ] Mobile/tablet previews to show responsiveness

## Icons

- [ ] Item icon (Envato spec) — distinctive, on-brand
- [ ] Favicon + OG image shipped in the product
- [ ] Logo files (SVG/PNG) included in the package

## License

- [ ] Extended license terms clear (one-time per-project use)
- [ ] CodeCanyon license type selected (Regular/Extended) with rationale
- [ ] No GPL/AGPL dependencies that would violate Envato terms
- [ ] Third-party attribution (icons/fonts) documented

## Support

- [ ] Support channel defined (Envato comments + email/ticket)
- [ ] Support SLA documented (e.g., 48h response) — **critical for self-hosted buyers**
- [ ] Known limitations documented (e.g., Windows-only agent)
- [ ] Refund policy aligned with Envato rules

## Versioning

- [ ] Semantic versioning policy (see 15-Release-History.md)
- [ ] Free updates within major version; paid major upgrades defined (v2.0)
- [ ] Version displayed in-app + in package metadata

## Changelog

- [ ] CHANGELOG.md shipped with the product, updated per release
- [ ] Release notes linked from the listing
- [ ] Breaking-change notes for upgrades

## SEO Description

- [ ] Title ≤ 70 chars: "WorkLensAI — Self-Hosted AI Employee Monitoring & Productivity"
- [ ] Description (≤ 200 chars preview): self-hosted, BYOK AI, one-time license, screenshots, productivity analytics, Windows agent, GDPR-friendly
- [ ] 10+ targeted tags (employee monitoring, productivity, time tracking, self-hosted, AI, workforce analytics, screenshots, Windows agent…)
- [ ] Keyword-rich but honest copy — no false feature claims

## FAQ

- [ ] 10+ FAQs: What happens to data? (stays on your server) · Do I need an AI key? (BYOK — OpenAI/Ollama…) · How many users? · Mac/Linux support? · Docker required? · Updates policy? · Can employees see their data? · GDPR compliance? · Refunds? · Installation help?
- [ ] FAQs link to the corresponding docs section

---

## Pre-submission review gate

- [ ] Fresh install from the downloadable package (not the dev repo) works end-to-end
- [ ] Package excludes: node_modules, .env, dev logs, internal scripts, test artifacts
- [ ] No TODO/FIXME/debug code in the shipped bundle
- [ ] Security checklist (12-Release-Checklist.md) fully green
- [ ] Beta feedback from ≥3 pilot buyers incorporated
