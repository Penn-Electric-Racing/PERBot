import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { RequisitionEmail } from './email.js';

/**
 * Email transport for `/benbuys done`. Pluggable so the sender can change without
 * touching the command:
 *   • gmail   — Gmail API `users.messages.send` on the electric@ mailbox via an OAuth2
 *               refresh token (no extra npm deps; plain fetch). The default.
 *   • webhook — POST the JSON email to an HTTP endpoint (e.g. a Power Automate "When an
 *               HTTP request is received" flow with a Gmail "Send email" action).
 * `createMailer()` returns null when nothing is configured; `done` then refuses unless
 * `--no-send` is given, so a half-configured deploy can never mark rows ordered silently.
 */
export interface Mailer {
  readonly name: string;
  send(email: RequisitionEmail): Promise<{ id: string }>;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 5322 text/plain message. Header values are ASCII here (addresses, bracket tags, digits). */
export function toRfc822(email: RequisitionEmail): string {
  const headers = [
    `From: ${email.from}`,
    `To: ${email.to.join(', ')}`,
    email.cc.length ? `Cc: ${email.cc.join(', ')}` : '',
    `Subject: ${email.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean);
  return `${headers.join('\r\n')}\r\n\r\n${email.body.replace(/\r?\n/g, '\r\n')}`;
}

export class GmailApiMailer implements Mailer {
  readonly name = 'gmail';
  constructor(
    private creds: { clientId: string; clientSecret: string; refreshToken: string },
    private fetchFn: typeof fetch = fetch
  ) {}

  private async accessToken(): Promise<string> {
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Gmail OAuth token refresh failed: ${res.status} ${data.error ?? ''} ${data.error_description ?? ''}`.trim());
    }
    return data.access_token as string;
  }

  async send(email: RequisitionEmail): Promise<{ id: string }> {
    const token = await this.accessToken();
    const res = await this.fetchFn('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: base64url(toRfc822(email)) }),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Gmail send failed: ${res.status} ${data?.error?.message ?? ''}`.trim());
    }
    logger.info(`BenBuys email sent via Gmail (id ${data.id}): ${email.subject}`);
    return { id: String(data.id ?? '') };
  }
}

export class WebhookMailer implements Mailer {
  readonly name = 'webhook';
  constructor(private url: string, private fetchFn: typeof fetch = fetch) {}

  async send(email: RequisitionEmail): Promise<{ id: string }> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: email.from,
        to: email.to.join(';'),
        cc: email.cc.join(';'),
        subject: email.subject,
        body: email.body,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Email webhook failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    logger.info(`BenBuys email sent via webhook: ${email.subject}`);
    return { id: res.headers.get('x-ms-workflow-run-id') ?? '' };
  }
}

/** Pick the transport from config; null when none is configured. */
export function createMailer(): Mailer | null {
  const m = config.benbuys.mail;
  if (m.transport === 'gmail' && m.gmailClientId && m.gmailClientSecret && m.gmailRefreshToken) {
    return new GmailApiMailer({ clientId: m.gmailClientId, clientSecret: m.gmailClientSecret, refreshToken: m.gmailRefreshToken });
  }
  if (m.transport === 'webhook' && m.webhookUrl) return new WebhookMailer(m.webhookUrl);
  return null;
}
