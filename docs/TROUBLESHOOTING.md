# OmniSight Troubleshooting

## Common Issues

### 1. Application Won't Start

**Symptoms:** `npm start` or `npm run dev` fails immediately.

**Possible Causes:**
- Missing environment variables
- Database connection failure
- Port already in use

**Solutions:**

```bash
# Check environment variables
node -e "require('./src/lib/auth.ts')" 2>&1 | head -5

# Verify database connection
npx prisma db push --dry-run

# Check if port 3000 is in use
lsof -i :3000

# Kill existing process
kill $(lsof -t -i :3000)
```

### 2. Database Connection Error

**Symptoms:** `Error: P1001: Can't reach database server`

**Solutions:**
1. Verify `DATABASE_URL` in `.env`
2. Ensure PostgreSQL is running
3. Check firewall rules
4. For Supabase: ensure you're using the pooled connection string (port 6543)
5. For migrations: use the direct connection string (port 5432) in `DIRECT_URL`

```bash
# Test connection
psql "$DATABASE_URL" -c "SELECT 1"
```

### 3. Prisma Client Not Generated

**Symptoms:** `Error: @prisma/client did not initialize yet`

**Solutions:**
```bash
npx prisma generate
# or
npm run db:generate
```

### 4. Stale Prisma Client After Migration

**Symptoms:** Missing table/column errors after pulling new code.

**Solutions:**
```bash
npx prisma migrate deploy
npx prisma generate
# Restart the application
```

### 5. Authentication Fails (Login Returns 401)

**Symptoms:** Valid credentials rejected.

**Possible Causes:**
- `JWT_SECRET` not set or changed
- Session cookie not sent
- Placeholder JWT_SECRET detected

**Solutions:**
1. Ensure `JWT_SECRET` is set and ≥ 16 characters
2. Ensure `JWT_SECRET` is not a placeholder value
3. Clear browser cookies and try again
4. Check that `SESSION_COOKIE_NAME` matches your cookie

### 6. Organization Context Lost

**Symptoms:** 403 errors after login, "Insufficient permissions" messages.

**Possible Causes:**
- No `OrganizationMembership` for the user
- Organization is suspended/archived
- JWT has stale organization data

**Solutions:**
1. Verify the user has an active `OrganizationMembership`
2. Check organization status: `SELECT status FROM "Organization" WHERE id = '...'`
3. Log out and log back in to refresh the JWT

### 7. Agent Enrollment Fails

**Symptoms:** Agent cannot connect or authenticate.

**Possible Causes:**
- `AgentAccount` not created for the employee
- Employee not approved (`agentApproved = false`)
- Device claim not approved
- Organization suspended

**Solutions:**
1. Create an `AgentAccount` via Admin → Employees → [Employee] → Agent Account
2. Set `agentApproved = true` on the employee
3. Approve the device claim via Admin → Agent Approvals
4. Verify organization status is `active`

### 8. Screenshots Not Appearing

**Symptoms:** Screenshots uploaded but not visible in the admin.

**Possible Causes:**
- Storage driver misconfigured
- Supabase credentials wrong
- Screenshot consent not granted

**Solutions:**
1. Check `STORAGE_DRIVER` setting
2. For `supabase`: verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
3. For `local`: ensure `uploads/` directory exists and is writable
4. Verify screenshot consent is granted for the employee

```bash
# Check storage health
curl http://localhost:3000/api/health
```

### 9. Live-Updates Not Working

**Symptoms:** Dashboard doesn't update in real-time.

**Possible Causes:**
- Live-updates service not running
- WebSocket URL misconfigured
- CORS issue

**Solutions:**
1. Ensure the live-updates service is running on port 3010
2. Check `NEXT_PUBLIC_LIVE_UPDATES_URL` is set correctly
3. In dev: should be `http://localhost:3010`
4. In production: should be the public URL of the live-updates service
5. Check browser console for WebSocket errors

```bash
# Start live-updates manually
cd mini-services/live-updates
bun index.ts
```

### 10. Build Fails

**Symptoms:** `npm run build` errors.

**Solutions:**
```bash
# Clear Next.js cache
rm -rf .next

# Regenerate Prisma client
npx prisma generate

# Check TypeScript
npx tsc --noEmit

# Retry build
npm run build
```

### 11. Rate Limiting Blocks Login

**Symptoms:** `429 Too Many Requests` on login.

**Solutions:**
1. Wait for the rate limit window to expire (15 minutes)
2. Check the `Retry-After` header for exact wait time
3. If persistent, clear the rate limit counter:
   ```sql
   DELETE FROM "RateLimitCounter" WHERE key LIKE 'login:%';
   ```

### 12. SVG Upload Rejected

**Symptoms:** "This SVG contains unsupported or unsafe content" error.

**Solutions:**
1. Remove `<script>` tags from the SVG
2. Remove event handlers (`onclick`, `onload`, etc.)
3. Remove `<style>` elements
4. Remove `javascript:` URIs
5. Ensure the SVG is valid and well-formed
6. Keep file size under 1MB

### 13. Port Conflict

**Symptoms:** `EADDRINUSE: address already in use :::3000`

**Solutions:**
```bash
# Find the process using port 3000
lsof -i :3000

# Kill it
kill $(lsof -t -i :3000)

# Or use a different port
PORT=3001 npm start
```

### 14. Node.js Version Mismatch

**Symptoms:** Unexpected errors, missing features.

**Solutions:**
```bash
# Check Node.js version
node --version  # Should be ≥ 20

# Update Node.js
# Using nvm:
nvm install 20
nvm use 20
```

### 15. Agent Shows "Offline" But Is Running

**Symptoms:** Agent is running but shows offline in admin.

**Possible Causes:**
- Heartbeat not reaching server
- Agent token expired
- Network connectivity issue

**Solutions:**
1. Check agent logs for errors
2. Verify server URL configuration
3. Check if the agent token has expired (24h lifetime)
4. Ensure the device status is `online` or `offline` (not `inactive`)

### 16. Location Not Updating

**Symptoms:** Location data not appearing on the map.

**Possible Causes:**
- Location consent not granted
- Movement below 5 km threshold
- Native location API unavailable

**Solutions:**
1. Verify location consent is granted
2. Check if the employee has moved ≥ 5 km since last accepted location
3. The agent falls back to IP-based location when native GPS is unavailable
4. IP-based locations have no accuracy field (null)

### 17. Audio Transcription Fails

**Symptoms:** Uploaded audio not transcribed.

**Possible Causes:**
- Transcription service not running
- FFmpeg not installed
- Whisper model not available
- File too large

**Solutions:**
1. Start the transcription service: `cd mini-services/transcription && python main.py`
2. Install FFmpeg: `apt install ffmpeg`
3. Check `WHISPER_MODEL` setting
4. Audio file must be under 100MB and under 2 hours

### 18. Production Bootstrap Fails

**Symptoms:** `npx tsx scripts/bootstrap-super-admin.ts` fails.

**Solutions:**
1. Ensure `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` are set
2. Ensure `DATABASE_URL` is correct
3. Run `npx prisma migrate deploy` first
4. The command is idempotent — safe to run multiple times

## Getting Help

If you encounter an issue not covered here:

1. Check the application logs
2. Review the audit log: `SELECT * FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT 100`
3. Check the health endpoint: `GET /api/health`
4. Review the browser console for client-side errors
5. Check the Node.js process logs
