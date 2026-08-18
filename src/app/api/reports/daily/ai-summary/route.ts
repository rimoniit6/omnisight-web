import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { callAIProvider } from '@/lib/ai-provider-helper';
import { authError, getSessionOrg, requireManagerOrg, parseJsonBody, BodyParseError, isValidDate } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { excludeInternalAgentActivities } from '@/lib/agent-process';
import { localDayKey } from '@/lib/timezone';
import { effectiveLiveStatus } from '@/lib/presence';

// DS-P3-4: per-error-code fallback copy. The headline must reflect the ACTUAL
// cause — "configure a provider" is wrong when one IS configured (e.g. an
// AI_HTTP_404 base-URL mismatch). Every message is safe: no keys, no secrets.
function aiFallbackForCode(
  code: string | null,
  productivityScore: number
): {
  summary: string;
  finding: string;
  concern: string;
  recommendation: string;
  rating: string;
  nextDayFocus: string;
} {
  const rating = productivityScore > 70 ? 'Good' : productivityScore > 50 ? 'Fair' : 'Needs Improvement';
  switch (code) {
    case 'AI_PROVIDER_NOT_CONFIGURED':
      return {
        summary: 'No AI provider is configured. Configure an AI provider in Settings to enable AI-powered insights.',
        finding: 'AI provider not configured',
        concern: 'AI provider not configured',
        recommendation: 'Go to Settings → AI Provider to configure',
        rating,
        nextDayFocus: 'Configure AI provider for smarter insights',
      };
    case 'AI_KEY_MISSING':
    case 'AI_KEY_DECRYPT_FAILED':
      return {
        summary: 'The AI provider is configured but its API key is missing or unreadable. Re-enter the API key in Settings → AI Provider.',
        finding: `AI provider key issue (${code})`,
        concern: `AI provider key issue (${code})`,
        recommendation: 'Go to Settings → AI Provider and re-enter the API key',
        rating,
        nextDayFocus: 'Restore the AI provider API key',
      };
    case 'AI_HTTP_404':
      return {
        summary: 'The AI provider endpoint was not found (HTTP 404). This usually means the provider base URL points at the wrong protocol — check Settings → AI Provider.',
        finding: `AI provider endpoint not found (${code})`,
        concern: `AI provider returned ${code} — check the base URL`,   
        recommendation: 'Open Settings → AI Provider and verify the base URL matches the selected provider',
        rating,
        nextDayFocus: 'Fix the AI provider base URL',
      };
    case 'AI_CONFIG_INCOMPATIBLE':
      return {
        summary: 'The AI provider configuration is incompatible (for example, a Google provider with an OpenAI-style base URL). Fix it in Settings → AI Provider.',
        finding: `AI provider configuration incompatible (${code})`,
        concern: `AI provider configuration incompatible (${code})`,
        recommendation: 'Open Settings → AI Provider and align provider, model and base URL',
        rating,
        nextDayFocus: 'Fix the AI provider configuration',
      };
    case 'AI_HTTP_401':
    case 'AI_HTTP_403':
      return {
        summary: 'The AI provider rejected the API key (HTTP ' + (code === 'AI_HTTP_401' ? '401' : '403') + '). Check the key in Settings → AI Provider.',
        finding: `AI provider rejected the API key (${code})`,
        concern: `AI provider returned ${code} — check the API key`,
        recommendation: 'Go to Settings → AI Provider and verify the API key',
        rating,
        nextDayFocus: 'Verify the AI provider API key',
      };
    case 'AI_CALL_FAILED':
    case 'AI_REQUEST_FAILED':
      return {
        summary: 'The AI provider could not be reached right now. The report data below is still accurate — retry the summary shortly.',
        finding: `AI provider request failed (${code})`,
        concern: `AI provider request failed (${code})`,
        recommendation: 'Retry the AI summary, or check the AI provider connection in Settings',
        rating,
        nextDayFocus: 'Retry the AI summary',
      };
    default:
      return {
        summary: 'AI summary generation is currently unavailable. The report data below is complete and accurate.',
        finding: code ? `AI provider issue (${code})` : 'Unable to generate AI analysis',
        concern: code ? `AI provider returned ${code}` : 'AI provider unavailable',
        recommendation: 'Retry later or check the AI provider configuration in Settings',
        rating,
        nextDayFocus: 'Retry the AI summary or check Settings',
      };
  }
}

// POST /api/reports/daily/ai-summary
// Generate an AI-powered executive summary from daily report data
export async function POST(req: NextRequest) {
  try {
    // S-3: report AI summary generation requires manager-or-above.
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const { date } = body as { date?: string };

    // SECURITY (MO-ADMIN-06): client-supplied `reportData` is NEVER trusted —
    // a caller could forge productivity scores, employee counts, screenshots
    // or alerts and feed them into the AI prompt. Authoritative metrics are
    // ALWAYS derived from org-scoped DB data below. The field is accepted for
    // API compatibility but ignored.
    const targetDate = date ? new Date(date) : new Date();
    if (!isValidDate(targetDate)) {
      return NextResponse.json({ error: 'Invalid date. Provide a valid ISO date (e.g. 2026-08-13).' }, { status: 422 });
    }
    targetDate.setHours(0, 0, 0, 0);
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    // Tenant isolation: org identity comes from the authenticated session.
    const sessionOrg = await getSessionOrg(req);
    const org = sessionOrg
      ? await db.organization.findUnique({ where: { id: sessionOrg.id } })
      : null;
    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    const activeEmployees = await db.employee.count({
      where: { status: 'active', organizationId: org.id },
    });

    const activities = excludeInternalAgentActivities(await db.activity.findMany({
      where: { timestamp: { gte: targetDate, lt: nextDay }, employee: { organizationId: org.id } },
    }));

    let data: Record<string, unknown> = {};

      let totalDurationSec = 0;
      let productiveSec = 0;
      let neutralSec = 0;
      let unproductiveSec = 0;
      let idleSec = 0;

      for (const act of activities) {
        const dur = act.duration || 0;
        totalDurationSec += dur;
        if (act.type === 'idle') idleSec += dur;
        else if (act.category === 'productive') productiveSec += dur;
        else if (act.category === 'unproductive') unproductiveSec += dur;
        else neutralSec += dur;
      }

      const totalMin = Math.round(totalDurationSec / 60);
      const productivePct = totalMin > 0 ? Math.round((productiveSec / totalDurationSec) * 100) : 0;

      // Get alerts (org-scoped)
      const alertsCount = await db.alert.count({
        where: { createdAt: { gte: targetDate, lt: nextDay }, organizationId: org.id },
      });

      // Get screenshots (org-scoped)
      const screenshotsCount = await db.screenshot.count({
        where: { capturedAt: { gte: targetDate, lt: nextDay }, organizationId: org.id },
      });

      // Get online devices (heartbeat freshness, never the sticky column)
      const orgDevices = await db.device.findMany({
        where: { organizationId: org.id },
        select: { status: true, lastHeartbeat: true },
      });
      const onlineDevices = orgDevices.filter(
        (d) => effectiveLiveStatus(d.status, d.lastHeartbeat) === 'online'
      ).length;

      // Get flagged screenshots (org-scoped)
      const flaggedScreenshots = await db.screenshot.count({
        where: {
          capturedAt: { gte: targetDate, lt: nextDay },
          flagged: true,
          organizationId: org.id,
        },
      });

      // DS-P2-1: the date label is the ORG-LOCAL calendar day of the report
      // window. Previously `targetDate.toISOString()` (UTC) after a local
      // setHours(0,0,0,0) clamp shifted the label a day backward for UTC+
      // zones (e.g. Asia/Dhaka): requested 2026-07-01 → labeled 2026-06-30.
      const orgTz = org.timezone || 'UTC';
      data = {
        date: localDayKey(targetDate, orgTz),
        organization: { name: org.name },
        summary: {
          totalEmployees: activeEmployees,
          totalActivities: activities.length,
          totalWorkingMinutes: totalMin,
          productivityScore: productivePct,
          breakdown: {
            productive: { minutes: Math.round(productiveSec / 60), percent: Math.round((productiveSec / totalDurationSec) * 100) || 0 },
            neutral: { minutes: Math.round(neutralSec / 60), percent: Math.round((neutralSec / totalDurationSec) * 100) || 0 },
            unproductive: { minutes: Math.round(unproductiveSec / 60), percent: Math.round((unproductiveSec / totalDurationSec) * 100) || 0 },
            idle: { minutes: Math.round(idleSec / 60), percent: Math.round((idleSec / totalDurationSec) * 100) || 0 },
          },
          alertsCount,
          screenshotsCount,
          flaggedScreenshots,
          onlineDevices,
        },
      };

    const summary = data.summary as Record<string, unknown>;
    const breakdown = summary.breakdown as Record<string, { minutes: number; percent: number }>;

    // Generate AI executive summary via callAIProvider (fetch-based, no SDK)
    const systemPrompt = `You are an expert workforce analytics AI assistant for OmniSight, a workforce monitoring platform. 
You generate clear, actionable executive summaries for daily productivity reports. 
Always be professional, data-driven, and constructive. 
Respond in valid JSON format with these exact fields:
{
  "executiveSummary": "2-3 sentence high-level overview of the day's productivity",
  "keyFindings": ["finding 1", "finding 2", "finding 3", "finding 4"],
  "highlights": ["positive highlight 1", "positive highlight 2"],
  "concerns": ["concern 1", "concern 2"],
  "recommendations": ["actionable recommendation 1", "recommendation 2"],
  "productivityRating": "Excellent" | "Good" | "Fair" | "Needs Improvement",
  "nextDayFocus": "Brief focus area for tomorrow"
}`;

    const userPrompt = `Generate an executive summary for this daily workforce report:

📅 Date: ${data.date}
🏢 Organization: ${(data.organization as Record<string, string>).name}

📊 Key Metrics:
- Total Employees: ${summary.totalEmployees}
- Total Activities Logged: ${summary.totalActivities}
- Total Working Time: ${summary.totalWorkingMinutes} minutes (${(Number(summary.totalWorkingMinutes) / 60).toFixed(1)} hours)
- Productivity Score: ${summary.productivityScore}%
- Alerts: ${summary.alertsCount}
- Screenshots Captured: ${summary.screenshotsCount}
- Flagged Screenshots: ${summary.flaggedScreenshots || 0}
- Online Devices: ${summary.onlineDevices}

⏱️ Time Breakdown:
- Productive: ${breakdown.productive.minutes}m (${breakdown.productive.percent}%)
- Neutral: ${breakdown.neutral.minutes}m (${breakdown.neutral.percent}%)
- Unproductive: ${breakdown.unproductive.minutes}m (${breakdown.unproductive.percent}%)
- Idle: ${breakdown.idle.minutes}m (${breakdown.idle.percent}%)`;

    const aiResult = await callAIProvider(systemPrompt, userPrompt, {
      maxTokens: 800,
      temperature: 0.3,
    });

    // Safe structured diagnostics — the code never contains the API key or
    // any secret. Log the real failure reason so operators can see whether it
    // is a config problem (AI_PROVIDER_NOT_CONFIGURED / AI_KEY_MISSING / …)
    // or a provider/HTTP problem (AI_HTTP_401 / AI_HTTP_404 / …).
    if (aiResult?.error) {
      log.warn('reports.daily.ai_summary.unavailable', {
        code: aiResult.error,
        provider: aiResult.provider || 'n/a',
      }, requestContext(req));
    } else if (!aiResult) {
      log.warn('reports.daily.ai_summary.call_failed', {
        code: 'AI_CALL_FAILED',
      }, requestContext(req));
    }

    let aiSummary: Record<string, unknown>;
    // If the call threw (outer catch path), report AI_CALL_FAILED rather than
    // misleading the user with 'not configured'.
    const aiError = aiResult?.error ?? (!aiResult ? 'AI_CALL_FAILED' : null);
    if (aiResult?.text) {
      try {
        // Models often wrap JSON answers in markdown code fences (```json …
        // ```). Strip them so the response parses as the requested JSON
        // contract instead of falling back to raw text.
        const fenced = aiResult.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        aiSummary = JSON.parse(fenced);
      } catch {
        aiSummary = {
          executiveSummary: aiResult.text.substring(0, 400),
          keyFindings: ['Report data processed successfully'],
          highlights: ['Report generated'],
          concerns: [],
          recommendations: ['Continue monitoring workforce activity'],
          productivityRating: summary.productivityScore as number > 70 ? 'Good' : summary.productivityScore as number > 50 ? 'Fair' : 'Needs Improvement',
          nextDayFocus: 'Monitor productivity trends',
        };
      }
    } else {
      // Fallback when AI is unavailable — the safe aiError code tells the UI
      // exactly why (e.g. AI_PROVIDER_NOT_CONFIGURED, AI_KEY_MISSING,
      // AI_HTTP_404, …) without ever exposing the API key. DS-P3-4: the
      // headline must reflect the ACTUAL cause — "configure a provider" is
      // wrong when one IS configured (e.g. AI_HTTP_404 base-URL mismatch).
      const fallback = aiFallbackForCode(aiError, summary.productivityScore as number);
      aiSummary = {
        executiveSummary: fallback.summary,
        keyFindings: [fallback.finding],
        highlights: [`Productivity score: ${summary.productivityScore}%`, `${summary.totalEmployees} active employees`],
        concerns: [fallback.concern],
        recommendations: [fallback.recommendation],
        productivityRating: fallback.rating,
        nextDayFocus: fallback.nextDayFocus,
      };
    }

    return NextResponse.json({
      success: true,
      date: data.date,
      aiSummary,
      reportSnapshot: data,
      aiProviderUsed: aiResult?.provider ?? null,
      aiModelUsed: aiResult?.model ?? null,
      aiError,
    });
  } catch (error) {
    log.error('reports.daily.ai_summary.error', { reason: (error as Error)?.message }, requestContext(req));

    return NextResponse.json({
      success: true,
      date: localDayKey(new Date(), 'UTC'),
      aiSummary: {
        executiveSummary: 'AI summary generation is temporarily unavailable. Using basic statistics.',
        keyFindings: ['Unable to generate AI analysis at this time'],
        highlights: ['Report data collected successfully'],
        concerns: ['AI service unavailable'],
        recommendations: ['Retry later or check AI provider configuration'],
        productivityRating: 'Fair',
        nextDayFocus: 'Ensure AI provider is properly configured',
      },
      fallback: true,
      aiError: 'AI_CALL_FAILED',
    });
  }
}
