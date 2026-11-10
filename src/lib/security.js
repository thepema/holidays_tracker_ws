import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'ht_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 8;
export const ADMIN_TOKEN_TTL_SECONDS = 60 * 60 * 8;

export const generateToken = () => crypto.randomBytes(32).toString('base64url');

export const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

export function setSessionCookie(reply, token) {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(reply) {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

function safeStringEqual(actual, expected) {
  const actualHash = crypto.createHash('sha256').update(String(actual)).digest();
  const expectedHash = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash) && String(actual).length === String(expected).length;
}

function getAdminTokenSecret() {
  return process.env.ADMIN_TOKEN_SECRET;
}

export function createAdminToken() {
  const secret = getAdminTokenSecret();
  if (!secret) throw new Error('ADMIN_TOKEN_SECRET is not configured');

  const payload = Buffer.from(JSON.stringify({
    sub: 'admin',
    exp: Math.floor(Date.now() / 1000) + ADMIN_TOKEN_TTL_SECONDS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function isValidAdminToken(token) {
  const secret = getAdminTokenSecret();
  if (!secret || typeof token !== 'string') return false;

  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length > 0) return false;

  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest();
  let suppliedSignature;
  try {
    suppliedSignature = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  if (suppliedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.sub === 'admin' && Number.isInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function getBearerToken(request) {
  return request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
}

export async function requireAdmin(request, reply) {
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_TOKEN_SECRET) {
    return reply.code(503).send({ error: 'La autenticación de administración no está configurada.' });
  }

  if (!isValidAdminToken(getBearerToken(request))) {
    return reply.code(401).send({ error: 'No autorizado.' });
  }
  request.isAdmin = true;
}

export async function requireAdminOrSession(request, reply) {
  if (isValidAdminToken(getBearerToken(request))) {
    request.isAdmin = true;
    return;
  }
  request.isAdmin = false;
  return requireSession(request, reply);
}

export async function requireSession(request, reply) {
  if (!request.user) return reply.code(401).send({ error: 'Inicia sesión para continuar.' });
}

export function verifyAdminPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof password !== 'string') return false;
  return safeStringEqual(password, expected);
}
