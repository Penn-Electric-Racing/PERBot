import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { buildAssertion, parseServiceAccountKey, ServiceAccountAuth } from '../../sources/googleAuth.js';
import { buildFolderIndex, routeFile, type DriveFile } from '../../sources/drive.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  client_email: 'perbot-drive@perbot-automations.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
};

test('service-account assertion is a valid RS256 JWT with the right claims', () => {
  const jwt = buildAssertion(KEY, ['https://www.googleapis.com/auth/drive.readonly'], 1_700_000_000);
  const [h, c, sig] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(claims.iss, KEY.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'));
  assert.equal(ok, true);
});

test('key parses from raw JSON or base64, and token is cached until near expiry', async () => {
  const raw = JSON.stringify(KEY);
  assert.equal(parseServiceAccountKey(raw).client_email, KEY.client_email);
  assert.equal(parseServiceAccountKey(Buffer.from(raw).toString('base64')).client_email, KEY.client_email);
  assert.throws(() => parseServiceAccountKey('{"client_email":"x"}'));

  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: `tok${calls}`, expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  const auth = new ServiceAccountAuth(KEY, ['s'], fakeFetch);
  assert.equal(await auth.accessToken(), 'tok1');
  assert.equal(await auth.accessToken(), 'tok1');
  assert.equal(calls, 1);
});

const f = (id: string, name: string, mimeType: string, parent?: string, extra: Partial<DriveFile> = {}): DriveFile => ({
  id,
  name,
  mimeType,
  parents: parent ? [parent] : undefined,
  modifiedTime: '2026-09-01T00:00:00Z',
  createdTime: '2026-09-01T00:00:00Z',
  ...extra,
});

test('folder index builds breadcrumbs from the drive root and applies exclusions', () => {
  const folders = [
    f('mech', 'Mechanical', 'application/vnd.google-apps.folder', 'DRIVE'),
    f('acc', 'Accumulator', 'application/vnd.google-apps.folder', 'mech'),
    f('photos', 'Photos', 'application/vnd.google-apps.folder', 'acc'),
  ];
  const index = buildFolderIndex(folders, new Map([['DRIVE', 'PER Shared Drive']]), ['photos']);
  const doc = f('d1', 'Pack CDR', 'application/vnd.google-apps.document', 'acc');
  const pic = f('p1', 'IMG_1.jpg', 'image/jpeg', 'photos');
  assert.deepEqual(index.pathOf(doc), ['PER Shared Drive', 'Mechanical', 'Accumulator']);
  assert.equal(index.excluded(doc), false);
  assert.equal(index.excluded(pic), true);
  assert.deepEqual(index.pathOf(f('x', 'orphan', 'text/plain', 'missing')), []);
});

test('files route to export, download or skip by type and size', () => {
  const max = 20_000_000;
  assert.deepEqual(routeFile(f('a', 'Doc', 'application/vnd.google-apps.document'), max), { type: 'export', mime: 'text/markdown' });
  assert.deepEqual(routeFile(f('b', 'Sheet', 'application/vnd.google-apps.spreadsheet'), max), { type: 'export', mime: 'text/csv' });
  assert.deepEqual(routeFile(f('c', 'x.pdf', 'application/pdf', undefined, { size: '1000' }), max), { type: 'download', parser: 'pdf' });
  assert.equal(routeFile(f('d', 'big.pdf', 'application/pdf', undefined, { size: String(max + 1) }), max).type, 'skip');
  assert.equal(routeFile(f('e', 'part.SLDPRT', 'application/octet-stream'), max).type, 'skip');
  assert.equal(routeFile(f('g', 'Folder', 'application/vnd.google-apps.folder'), max).type, 'skip');
});
