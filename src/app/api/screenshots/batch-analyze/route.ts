import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { callAIProviderVision } from '@/lib/ai-provider-helper';
import type { Prisma } from '@prisma/client';
import { authError, requireAdminOrg } from '@/lib/api';
import { screenshotAiInput } from '@/lib/storage';

// POST /api/screenshots/batch-analyze — Batch OCR + AI analysis (max 10)
// No mock/fabricated fallbacks: items that cannot be analyzed return an honest
// error entry and are NOT persisted. Successful updates are committed atomically.
// Tenant isolation: only screenshots from the caller's organization are
// processed — cross-org ids are excluded.
export async function POST(req: NextRequest) {
  try {
    // Mutation: admin-or-above role + organization scope.
    const scope = await requireAdminOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    const body = await req.json();
    const { screenshotIds } = body as { screenshotIds: string[] };

    if (!Array.isArray(screenshotIds) || screenshotIds.length === 0) {
      return NextResponse.json({ error: 'screenshotIds is required and must be a non-empty array' }, { status: 400 });
    }

    if (screenshotIds.length > 10) {
      return NextResponse.json({ error: 'Maximum 10 screenshots per batch' }, { status: 400 });
    }

    // Fetch all screenshots with employee info (scoped to caller's org)
    const screenshots = await db.screenshot.findMany({
      where: { id: { in: screenshotIds }, organizationId: orgId },
      include: {
        employee: { select: { firstName: true, lastName: true, designation: true } },
      },
    });

    if (screenshots.length === 0) {
      return NextResponse.json({ error: 'No screenshots found for the provided IDs' }, { status: 404 });
    }

    const results: {
      id: string;
      ocrText: string;
      aiAnalysis: Record<string, unknown>;
      flagged: boolean;
      flagReason: string | null;
      error?: string;
    }[] = [];
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    let analyzed = 0;
    let failed = 0;

    // Process each screenshot sequentially to avoid rate limits
    for (const screenshot of screenshots) {
      try {
        const appName = screenshot.appWindow || 'Unknown Application';
        const employeeName = `${screenshot.employee.firstName} ${screenshot.employee.lastName}`;
        const designation = screenshot.employee.designation || 'Employee';

        const imageUrl = screenshot.filePath;
        if (!imageUrl || !(imageUrl.startsWith('http') || imageUrl.startsWith('/'))) {
          throw new Error('No image file associated with this screenshot');
        }

        // Read the actual image object through the active storage driver
        // (base64 for local storage, a signed URL for Supabase Storage).
        const imageInput = await screenshotAiInput(orgId, imageUrl, screenshot.mimeType);
        if (!imageInput) {
          throw new Error(`Screenshot image file not found or unreadable: ${imageUrl}`);
        }

        // Step 1: OCR
        const ocrResult = await callAIProviderVision(
          'You are an expert OCR system. Extract ALL visible text with high fidelity.',
          `Extract all visible text from this screenshot. Preserve formatting, code, and layout. If no text visible, respond "No readable text detected."`,
          imageInput,
          { maxTokens: 500 }
        );
        const ocrText = ocrResult?.text || '';

        // Step 2: AI Analysis
        const analysisResult = await callAIProviderVision(
          'You are an AI workforce productivity analyst.',
          `Analyze this screenshot.

Context: ${employeeName} (${designation}). Active app: "${appName}".

Respond in valid JSON:
{
  "category": "Productive" | "Neutral" | "Unproductive",
  "confidence": 0.0-1.0,
  "summary": "Brief summary",
  "detectedElements": ["list"],
  "riskLevel": "low" | "medium" | "high",
  "recommendations": ["list"],
  "timeSpent": "estimated minutes"
}`,
          imageInput,
          { maxTokens: 500 }
        );

        const rawAnalysis = analysisResult?.text || '';
        let aiAnalysis: Record<string, unknown>;
        try {
          const parsed = JSON.parse(rawAnalysis);
          if (!parsed || typeof parsed !== 'object' || !parsed.category) {
            throw new Error('Malformed analysis response');
          }
          aiAnalysis = parsed;
        } catch {
          throw new Error('AI analysis returned invalid JSON');
        }

        const category = (aiAnalysis.category as string) || 'Neutral';
        const flagged = category === 'Unproductive';
        const flagReason = flagged ? `Non-work activity detected: ${appName}` : null;

        // Queue the update; committed atomically after the loop
        updates.push(
          db.screenshot.update({
            where: { id: screenshot.id },
            data: {
              ocrText,
              aiAnalysis: JSON.stringify(aiAnalysis),
              flagged,
              flagReason,
            },
          })
        );

        results.push({
          id: screenshot.id,
          ocrText,
          aiAnalysis,
          flagged,
          flagReason,
        });
        analyzed++;
      } catch (err) {
        console.error(`Error processing screenshot ${screenshot.id}:`, err);
        results.push({
          id: screenshot.id,
          ocrText: '',
          aiAnalysis: {},
          flagged: false,
          flagReason: null,
          error: err instanceof Error ? err.message : 'Analysis failed',
        });
        failed++;
      }
    }

    if (updates.length > 0) {
      await db.$transaction(updates);
    }

    return NextResponse.json({ results, analyzed, failed });
  } catch (error) {
    console.error('Batch analyze error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
