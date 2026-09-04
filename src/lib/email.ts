// OmniSight — Email normalization utility.
//
// Canonical rule: input email → trim → lowercase → use for storage/lookup.
// This prevents silent lookup failures caused by mixed-case emails (e.g.
// "John@Example.com" vs "john@example.com") in PostgreSQL's case-sensitive
// default collation.

/**
 * Normalize an email address for consistent storage and lookup.
 * Returns null if the input is not a non-empty string after trimming.
 */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// ─── Outbound email ─────────────────────────────────────────────────────────
// Resend is the email provider. When a RESEND_API_KEY is configured, email is
// sent for real; otherwise delivery degrades to a clearly-logged mock so local
// dev and CI never crash on a missing key.

import { Resend } from 'resend';

export const EMAIL_PROVIDER_ENABLED = Boolean(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'OmniSight <onboarding@omnisight.com>';

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key) : null;
}

export interface DataExpiryEmailResult {
  sent: boolean;
  recipientCount: number;
  provider: 'resend' | 'mock';
  logLine: string;
}

/**
 * Send a transactional email via Resend when configured, otherwise log a mock.
 * Returns a normalized result shape so call sites never need to branch.
 */
async function sendEmail(
  to: string | string[],
  subject: string,
  body: string
): Promise<DataExpiryEmailResult> {
  const recipients = Array.isArray(to) ? to : [to];
  const unique = [...new Set(recipients.filter((e) => typeof e === 'string' && e.length > 0))];
  const html = body
    .split('\n')
    .map((line) => {
      const safe = line.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
      return line.trim() === '' ? '<br/>' : `<p style="margin:4px 0;">${safe}</p>`;
    })
    .join('');

  const resend = getResend();
  if (resend && unique.length > 0) {
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: unique,
        subject,
        text: body,
        html: `<div style="font-family:Arial,sans-serif;color:#222;">${html}</div>`,
      });
      const logLine = `[email:resend] ${subject} -> ${unique.join(', ')}`;
      console.log(logLine);
      return { sent: true, recipientCount: unique.length, provider: 'resend', logLine };
    } catch (error) {
      const logLine = `[email:resend:error] ${subject} -> ${unique.join(', ')} :: ${String(error)}`;
      console.error(logLine);
      // Real-send failure is surfaced (caller may catch) but treated as not-sent.
      return { sent: false, recipientCount: 0, provider: 'resend', logLine };
    }
  }

  const logLine = `[email:mock] ${subject} -> ${unique.join(', ') || '(no recipients)'}\n${body}`;
  console.log(logLine);
  return { sent: true, recipientCount: unique.length, provider: 'mock', logLine };
}

/**
 * Send a data-expiry reminder to a list of recipients.
 *
 * @param to       List of recipient emails (org admins + super admins).
 * @param orgName  Organization display name for the greeting/body.
 * @param daysLeft Days until the data-expiry cutoff (7 = warning, 0 = expired
 *                 today). Used to pick subject + body copy.
 * @param exportLink Where the user can download/export older data (Reports /
 *                 admin export tool).
 */
export async function sendDataExpiryReminder(
  to: string[],
  orgName: string,
  daysLeft: number,
  exportLink: string
): Promise<DataExpiryEmailResult> {
  const recipients = [...new Set(to.filter((e) => typeof e === 'string' && e.length > 0))];

  const subject =
    daysLeft === 0
      ? 'ACTION REQUIRED: Your OmniSight data has expired today'
      : `Your OmniSight data is expiring in ${daysLeft} days`;

  const body =
    daysLeft === 0
      ? [
          `Hello,`,
          ``,
          `The retention window for data belonging to "${orgName}" ends TODAY.`,
          `Please download your historical data immediately before it is removed.`,
          `You can download it from: ${exportLink}`,
          ``,
          `— OmniSight`,
        ].join('\n')
      : [
          `Hello,`,
          ``,
          `Data older than the retention window for "${orgName}" will expire in ${daysLeft} days.`,
          `Please manually download and archive any data you need before it is removed.`,
          `You can find the export section here: ${exportLink}`,
          ``,
          `— OmniSight`,
        ].join('\n');

  return sendEmail(recipients, subject, body);
}

// ─── Welcome email (Super Admin account generation) ─────────────────────────

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
export const GENERATED_PASSWORD_LENGTH = 16;

/**
 * Send a welcome/credentials email to the admin of an organization that a
 * Super Admin provisioned via the "Create Organization" flow.
 */
export async function sendWelcomeEmail(
  to: string,
  orgName: string,
  roleLabel: string,
  loginUrl: string
): Promise<DataExpiryEmailResult> {
  const subject = `Welcome to OmniSight — your "${orgName}" workspace is ready`;

  const body = [
    `Hello,`,
    ``,
    `Your "${orgName}" organization has been provisioned on OmniSight by an administrator.`,
    `You have been granted the "${roleLabel}" role.`,
    ``,
    `A temporary password was set for your account. On your first login you will be`,
    `required to choose a new, permanent password.`,
    ``,
    `To sign in, visit: ${loginUrl}`,
    ``,
    `If you need your temporary password reset, contact your administrator.`,
    ``,
    `— OmniSight`,
  ].join('\n');

  return sendEmail(to, subject, body);
}

export { APP_URL };
