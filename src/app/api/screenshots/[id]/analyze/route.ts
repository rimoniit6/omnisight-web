import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { callAIProviderVision } from '@/lib/ai-provider-helper';
import { authError, requireAdminOrg } from '@/lib/api';
import { screenshotAiInput } from '@/lib/storage';

// POST /api/screenshots/[id]/analyze — AI-powered OCR + analysis
// Only real data is ever persisted: if the image file is missing, unreadable,
// or the VLM fails, the request fails honestly (502) instead of fabricating
// OCR text or analysis. No mock fallbacks, no hardcoded scores.
// Tenant isolation: only screenshots from the caller's organization are
// analyzable — cross-org ids return 404.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Mutation: admin-or-above role + organization scope.
    const scope = await requireAdminOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    const { id } = await params;
    const screenshot = await db.screenshot.findFirst({
      where: { id, organizationId: orgId },
      include: {
        employee: { select: { firstName: true, lastName: true, designation: true } },
      },
    });

    if (!screenshot) {
      return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
    }

    const appName = screenshot.appWindow || 'Unknown Application';
    const employeeName = `${screenshot.employee.firstName} ${screenshot.employee.lastName}`;
    const designation = screenshot.employee.designation || 'Employee';

    const imageUrl = screenshot.filePath;

    // No image on record — nothing to analyze
    if (!imageUrl || !(imageUrl.startsWith('http') || imageUrl.startsWith('/'))) {
      return NextResponse.json(
        { error: 'No image file associated with this screenshot. Upload the image before analysis.' },
        { status: 422 }
      );
    }

    // Read the actual image object through the active storage driver (base64
    // for local storage, a time-limited signed URL for Supabase Storage).
    const imageInput = await screenshotAiInput(orgId, imageUrl, screenshot.mimeType);
    if (!imageInput) {
      return NextResponse.json(
        { error: `Screenshot image file not found or unreadable: ${imageUrl}` },
        { status: 404 }
      );
    }

    // Step 1: OCR — Extract text from the real screenshot
    let ocrText = '';
    try {
      const ocrResult = await callAIProviderVision(
        'You are an expert OCR system. Extract ALL visible text with high fidelity.',
        `Extract all visible text from this screenshot. Preserve formatting, code structure, and layout. If no text is clearly visible, respond with "No readable text detected."`,
        imageInput,
        { maxTokens: 500 }
      );
      ocrText = ocrResult?.text || '';
    } catch (ocrError) {
      console.error('OCR failed:', ocrError);
      return NextResponse.json(
        { error: 'OCR failed. No analysis was saved.' },
        { status: 502 }
      );
    }

    // Step 2: AI Analysis — classify productivity from the real screenshot
    const aiAnalysis: Record<string, unknown> = await (async () => {
      try {
        const analysisResult = await callAIProviderVision(
        'You are an AI workforce productivity analyst. Analyze screenshots and classify productivity.',
        `Analyze this screenshot and provide assessment.

Context: This is from ${employeeName} (${designation}). Active app: "${appName}".

Respond in valid JSON:
{
  "category": "Productive" | "Neutral" | "Unproductive",
  "confidence": 0.0-1.0,
  "summary": "Brief summary",
  "detectedElements": ["list of UI elements/apps"],
  "riskLevel": "low" | "medium" | "high",
  "recommendations": ["1-2 actionable recommendations"],
  "timeSpent": "estimated minutes"
}`,
        imageInput,
        { maxTokens: 500 }
      );

      const rawAnalysis = analysisResult?.text || '';
      try {
        const parsed = JSON.parse(rawAnalysis);
        if (!parsed || typeof parsed !== 'object' || !parsed.category) {
          throw new Error('Malformed analysis response');
        }
        return parsed;
      } catch {
        console.error('Analysis response was not valid JSON:', rawAnalysis);
        throw new Error('AI analysis returned invalid output');
      }
    } catch (analysisError) {
      console.error('VLM analysis failed:', analysisError);
      throw new Error('AI analysis failed');
    }
  })();

  const category = (aiAnalysis.category as string) || 'Neutral';
    const flagged = category === 'Unproductive';
    const flagReason = flagged ? `Non-work activity detected: ${appName}` : null;

    const updated = await db.screenshot.update({
      where: { id },
      data: {
        ocrText,
        aiAnalysis: JSON.stringify(aiAnalysis),
        flagged,
        flagReason,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    const status =
      message === 'AI analysis returned invalid output' || message === 'AI analysis failed' || message === 'OCR failed'
        ? 502
        : 500;
    console.error('Screenshot analyze error:', error);
    return NextResponse.json({ error: message === 'Internal server error' ? message : `Screenshot analysis failed. No analysis was saved.` }, { status });
  }
}
