import { createSign } from 'node:crypto';
import fs from 'node:fs/promises';

/**
 * Service-account auth for Google APIs with no `googleapis` dependency (same stance as the
 * BenBuys Gmail mailer): sign a JWT with the account's private key, trade it for a one-hour
 * access token at the OAuth token endpoint, cache until shortly before expiry.
 */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const TOKEN_URI = 'https://oauth2.googleapis.com/token';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts the raw key JSON, or the same JSON base64-encoded (easier to paste into a secret). */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw.trim(), 'base64').toString('utf8');
  const key = JSON.parse(text) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) {
    throw new Error('Service account key is missing client_email or private_key.');
  }
  return key;
}

export async function loadServiceAccountKey(opts: { json?: string; file?: string }): Promise<ServiceAccountKey | null> {
  if (opts.json) return parseServiceAccountKey(opts.json);
  if (opts.file) return parseServiceAccountKey(await fs.readFile(opts.file, 'utf8'));
  return null;
}

/** The signed JWT assertion Google's token endpoint accepts for a service account. */
export function buildAssertion(key: ServiceAccountKey, scopes: string[], nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes.join(' '),
      aud: key.token_uri || TOKEN_URI,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

export class ServiceAccountAuth {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly scopes: string[],
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  get email(): string {
    return this.key.client_email;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const res = await this.fetchFn(this.key.token_uri || TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: buildAssertion(this.key, this.scopes),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Google service-account token request failed: ${res.status} ${data.error ?? ''} ${data.error_description ?? ''}`.trim());
    }
    this.token = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
}
