import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'ht_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 8;

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

export async function requireAdmin(request, reply) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return reply.code(503).send({ error: 'La administración no está configurada.' });
  }

  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  const valid = suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);

  if (!valid) return reply.code(401).send({ error: 'No autorizado.' });
}

export async function requireSession(request, reply) {
  if (!request.user) return reply.code(401).send({ error: 'Inicia sesión para continuar.' });
}
