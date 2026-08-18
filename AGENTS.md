# AGENTS.md — OmniSight Development Rules

Rules for AI agents working in this repository. User instructions take precedence.

## Next.js development rule: never mix `next build` with a live `next dev`

Do not run `next build` while relying on the same `.next` directory for an active `next dev` server.

A production build can pollute the `.next` directory with production artifacts while development artifacts are still present. This may cause the dev server's route graph to become inconsistent and API routes such as `/api/health` or `/api/auth/login` to return the Next.js HTML 404 page instead of JSON (symptom in the UI: `Network error. Please try again.` on login — `response.json()` fails on HTML).

### If API routes unexpectedly return HTML/404 during development

1. Stop the running Next.js processes.
2. Delete `.next`.
3. Start the development server again.
4. Verify `/api/health`.
5. Verify `/api/auth/login`.
6. Verify `/api/auth/me`.

### Expected

```
GET /api/health
→ HTTP 200
→ Content-Type: application/json

POST /api/auth/login
→ JSON response
→ not an HTML 404 page.
```

### Prevention

- Run `next build` only when no dev server is using the same `.next`.
- After a build, delete `.next` (or run a clean checkout of it) before starting `next dev`.
- Do not modify source code if the root cause is only stale build state.