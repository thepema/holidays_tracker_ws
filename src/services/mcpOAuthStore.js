import crypto from 'node:crypto';
import { generateToken, hashToken } from '../lib/security.js';

export const MCP_DEFAULT_SCOPE = 'mcp:vacations';
export const AUTH_CODE_TTL_MS = 60 * 1000; // 60 segundos (OAuth 2.1 recomienda <= 60s y un solo uso)
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hora
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días
export const CLIENT_IDLE_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 días

const MAX_CLIENTS = 2000;
const MAX_AUTH_CODES = 5000;
const MAX_SESSIONS = 10000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
]);

const PKCE_VERIFIER_REGEX = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE_REGEX = /^[A-Za-z0-9\-_]{43,128}$/;

/** @type {Map<string, any>} */
const clients = new Map();
/** @type {Map<string, any>} */
const authCodes = new Map();
/** @type {Map<string, any>} */
const sessions = new Map();
/** @type {Map<string, string>} */
const accessTokenIndex = new Map();
/** @type {Map<string, string>} */
const refreshTokenIndex = new Map();

function evictOldestIfNeeded(map, maxEntries, onEvict) {
  while (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = map.get(oldestKey);
    map.delete(oldestKey);
    onEvict?.(entry, oldestKey);
  }
}

function removeSessionRecord(sessionId) {
  const existing = sessions.get(sessionId);
  if (!existing) return false;
  if (existing.accessTokenHash) {
    accessTokenIndex.delete(existing.accessTokenHash);
  }
  if (existing.refreshTokenHash) {
    refreshTokenIndex.delete(existing.refreshTokenHash);
  }
  sessions.delete(sessionId);
  return true;
}

export function cleanupExpiredOAuthEntries(now = Date.now()) {
  for (const [codeHash, record] of authCodes.entries()) {
    if (record.expiresAt <= now || (record.consumedAt && now - record.consumedAt > AUTH_CODE_TTL_MS)) {
      authCodes.delete(codeHash);
    }
  }

  for (const [sessionId, session] of sessions.entries()) {
    if (session.refreshExpiresAt <= now) {
      removeSessionRecord(sessionId);
      continue;
    }
    if (session.accessTokenHash && session.accessExpiresAt <= now) {
      accessTokenIndex.delete(session.accessTokenHash);
      session.accessTokenHash = null;
    }
  }

  for (const [clientId, client] of clients.entries()) {
    if (now - client.lastUsedAt > CLIENT_IDLE_TTL_MS) {
      clients.delete(clientId);
    }
  }
}

const cleanupTimer = setInterval(() => cleanupExpiredOAuthEntries(), CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

export function normalizeResourceUri(uri) {
  if (typeof uri !== 'string') return '';
  const trimmed = uri.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return '';
  }
}

export function isValidRedirectUri(rawUri) {
  if (typeof rawUri !== 'string' || !rawUri.trim() || rawUri.length > 2048) {
    return false;
  }
  if (rawUri.includes('#')) {
    return false;
  }
  try {
    const parsed = new URL(rawUri);
    const protocol = parsed.protocol.toLowerCase();
    if (FORBIDDEN_REDIRECT_SCHEMES.has(protocol)) {
      return false;
    }
    if (protocol === 'https:') {
      return Boolean(parsed.hostname);
    }
    if (protocol === 'http:') {
      const host = parsed.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    }
    // Esquemas nativos de aplicaciones de escritorio/IDE (ej. cursor://, vscode://, claude://)
    return /^[a-z][a-z0-9+.-]*:$/.test(protocol);
  } catch {
    return false;
  }
}

export function isValidPkceChallenge(challenge, method = 'S256') {
  return method === 'S256' && typeof challenge === 'string' && PKCE_CHALLENGE_REGEX.test(challenge);
}

export function verifyPkceS256(codeVerifier, expectedChallenge) {
  if (typeof codeVerifier !== 'string' || !PKCE_VERIFIER_REGEX.test(codeVerifier)) {
    return false;
  }
  if (typeof expectedChallenge !== 'string' || !PKCE_CHALLENGE_REGEX.test(expectedChallenge)) {
    return false;
  }
  const computed = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const computedBuf = Buffer.from(computed, 'utf8');
  const expectedBuf = Buffer.from(expectedChallenge, 'utf8');
  return computedBuf.length === expectedBuf.length && crypto.timingSafeEqual(computedBuf, expectedBuf);
}

function verifyClientSecret(client, suppliedSecret) {
  if (!client.clientSecretHash) {
    return true;
  }
  if (typeof suppliedSecret !== 'string' || !suppliedSecret) {
    return false;
  }
  const suppliedHash = Buffer.from(hashToken(suppliedSecret), 'utf8');
  const expectedHash = Buffer.from(client.clientSecretHash, 'utf8');
  return suppliedHash.length === expectedHash.length && crypto.timingSafeEqual(suppliedHash, expectedHash);
}

function normalizeScope(rawScope) {
  if (typeof rawScope !== 'string' || !rawScope.trim()) {
    return MCP_DEFAULT_SCOPE;
  }
  const tokens = rawScope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.includes(MCP_DEFAULT_SCOPE)) {
    tokens.unshift(MCP_DEFAULT_SCOPE);
  }
  return [...new Set(tokens)].join(' ');
}

/**
 * Registra un cliente OAuth 2.1 en memoria (RFC 7591 Dynamic Client Registration).
 */
export async function registerOAuthClient(metadata = {}) {
  const rawRedirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  if (rawRedirectUris.length === 0 || rawRedirectUris.length > 20) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      errorDescription: 'redirect_uris must be a non-empty array of valid URIs.',
    };
  }

  const redirectUris = [];
  for (const uri of rawRedirectUris) {
    if (!isValidRedirectUri(uri)) {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        errorDescription: `Invalid or disallowed redirect_uri: ${String(uri)}`,
      };
    }
    redirectUris.push(uri.trim());
  }

  const requestedAuthMethod = String(metadata.token_endpoint_auth_method || 'none').trim();
  const supportedAuthMethods = new Set(['none', 'client_secret_post', 'client_secret_basic']);
  if (!supportedAuthMethods.has(requestedAuthMethod)) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      errorDescription: `Unsupported token_endpoint_auth_method: ${requestedAuthMethod}`,
    };
  }

  const now = Date.now();
  const issuedAt = Math.floor(now / 1000);
  const clientId = `mcp_cli_${generateToken()}`;
  const rawSecret = requestedAuthMethod === 'none' ? undefined : `mcp_sec_${generateToken()}`;
  const clientName =
    typeof metadata.client_name === 'string' && metadata.client_name.trim()
      ? metadata.client_name.trim().slice(0, 120)
      : 'Agente MCP';
  const grantTypes = ['authorization_code', 'refresh_token'];
  const responseTypes = ['code'];
  const scope = normalizeScope(metadata.scope);

  evictOldestIfNeeded(clients, MAX_CLIENTS);
  const record = {
    clientId,
    clientSecretHash: rawSecret ? hashToken(rawSecret) : null,
    clientName,
    redirectUris: [...new Set(redirectUris)],
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethod: requestedAuthMethod,
    scope,
    createdAt: now,
    lastUsedAt: now,
  };
  clients.set(clientId, record);

  return {
    ok: true,
    client: {
      client_id: clientId,
      ...(rawSecret ? { client_secret: rawSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: issuedAt,
      client_name: clientName,
      redirect_uris: record.redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: requestedAuthMethod,
      scope,
    },
  };
}

/**
 * Obtiene un cliente registrado (o admite Client ID Metadata Document URL pública sin secreto).
 */
export async function findOAuthClient(clientId, redirectUri = '') {
  if (typeof clientId !== 'string' || !clientId.trim()) {
    return null;
  }
  const cleanId = clientId.trim();
  const existing = clients.get(cleanId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  // Soporte compatible con CIMD (MCP 2025-11-25): el agente se identifica con una URL https://
  if (cleanId.startsWith('https://') && cleanId.length <= 500) {
    try {
      const parsedClientUrl = new URL(cleanId);
      if (parsedClientUrl.protocol === 'https:' && parsedClientUrl.hostname && isValidRedirectUri(redirectUri)) {
        return {
          clientId: cleanId,
          clientSecretHash: null,
          clientName: parsedClientUrl.hostname,
          redirectUris: [redirectUri.trim()],
          grantTypes: ['authorization_code', 'refresh_token'],
          responseTypes: ['code'],
          tokenEndpointAuthMethod: 'none',
          scope: MCP_DEFAULT_SCOPE,
          isCimdClient: true,
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Crea un authorization_code de un solo uso (60s) vinculado a la API Key validada del usuario.
 */
export async function createAuthorizationCode({
  clientId,
  redirectUri,
  codeChallenge,
  codeChallengeMethod = 'S256',
  resource,
  scope,
  apiKey,
  userId,
}) {
  const now = Date.now();
  const code = `mcp_code_${generateToken()}`;
  const codeHash = hashToken(code);

  evictOldestIfNeeded(authCodes, MAX_AUTH_CODES);
  authCodes.set(codeHash, {
    codeHash,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    resource: normalizeResourceUri(resource),
    scope: normalizeScope(scope),
    apiKey: String(apiKey).trim().toLowerCase(),
    userId: Number(userId),
    createdAt: now,
    expiresAt: now + AUTH_CODE_TTL_MS,
    consumedAt: null,
  });

  return code;
}

function revokeSessionsByAuthCodeHash(codeHash) {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.authCodeHash === codeHash) {
      removeSessionRecord(sessionId);
    }
  }
}

/**
 * Consume un authorization_code verificando PKCE S256, redirect_uri, cliente y resource.
 */
export async function consumeAuthorizationCode({
  code,
  clientId,
  clientSecret,
  redirectUri,
  codeVerifier,
  resource,
}) {
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: 'invalid_request', errorDescription: 'Missing authorization code.' };
  }

  const now = Date.now();
  const codeHash = hashToken(code.trim());
  const record = authCodes.get(codeHash);

  if (!record) {
    return { ok: false, error: 'invalid_grant', errorDescription: 'Invalid or unknown authorization code.' };
  }

  if (record.consumedAt !== null) {
    // OAuth 2.1 §4.1.2: si un código ya consumido se reutiliza, revocar los tokens derivados de él.
    revokeSessionsByAuthCodeHash(codeHash);
    authCodes.delete(codeHash);
    return { ok: false, error: 'invalid_grant', errorDescription: 'Authorization code has already been used.' };
  }

  if (record.expiresAt <= now) {
    authCodes.delete(codeHash);
    return { ok: false, error: 'invalid_grant', errorDescription: 'Authorization code has expired.' };
  }

  record.consumedAt = now;

  if (record.clientId !== clientId) {
    return { ok: false, error: 'invalid_grant', errorDescription: 'Client mismatch for authorization code.' };
  }

  const client = await findOAuthClient(clientId, record.redirectUri);
  if (!client || !verifyClientSecret(client, clientSecret)) {
    return { ok: false, statusCode: 401, error: 'invalid_client', errorDescription: 'Client authentication failed.' };
  }

  if (!redirectUri || record.redirectUri !== redirectUri) {
    return { ok: false, error: 'invalid_grant', errorDescription: 'redirect_uri does not match authorization request.' };
  }

  if (!verifyPkceS256(codeVerifier, record.codeChallenge)) {
    return { ok: false, error: 'invalid_grant', errorDescription: 'PKCE code_verifier validation failed.' };
  }

  const normalizedRequestedResource = normalizeResourceUri(resource);
  if (record.resource && normalizedRequestedResource && record.resource !== normalizedRequestedResource) {
    return { ok: false, error: 'invalid_target', errorDescription: 'Resource indicator mismatch.' };
  }

  return {
    ok: true,
    grant: {
      codeHash,
      clientId: record.clientId,
      apiKey: record.apiKey,
      userId: record.userId,
      scope: record.scope,
      resource: normalizedRequestedResource || record.resource,
    },
  };
}

/**
 * Crea una sesión virtual en memoria para el agente respaldada por la API Key del usuario.
 */
export async function createVirtualSession({
  clientId,
  userId,
  apiKey,
  scope,
  resource,
  authCodeHash = null,
}) {
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const accessToken = `mcp_at_${generateToken()}`;
  const refreshToken = `mcp_rt_${generateToken()}`;
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);
  const resolvedScope = normalizeScope(scope);

  evictOldestIfNeeded(sessions, MAX_SESSIONS, (_evicted, evictedId) => removeSessionRecord(evictedId));

  const session = {
    id: sessionId,
    clientId,
    userId: Number(userId),
    apiKey: String(apiKey).trim().toLowerCase(),
    scope: resolvedScope,
    resource: normalizeResourceUri(resource),
    accessTokenHash,
    accessExpiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
    refreshTokenHash,
    refreshExpiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
    authCodeHash,
    createdAt: now,
    updatedAt: now,
  };

  sessions.set(sessionId, session);
  accessTokenIndex.set(accessTokenHash, sessionId);
  refreshTokenIndex.set(refreshTokenHash, sessionId);

  return {
    session,
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: resolvedScope,
  };
}

/**
 * Resuelve un Bearer access_token virtual y devuelve la sesión en memoria (incluyendo su apiKey).
 */
export async function findSessionByAccessToken(rawAccessToken) {
  if (typeof rawAccessToken !== 'string' || !rawAccessToken.trim()) {
    return { ok: false, reason: 'missing' };
  }

  const now = Date.now();
  const tokenHash = hashToken(rawAccessToken.trim());
  const sessionId = accessTokenIndex.get(tokenHash);
  if (!sessionId) {
    return { ok: false, reason: 'invalid' };
  }

  const session = sessions.get(sessionId);
  if (!session || session.refreshExpiresAt <= now) {
    removeSessionRecord(sessionId);
    return { ok: false, reason: 'expired' };
  }

  if (session.accessExpiresAt <= now) {
    accessTokenIndex.delete(tokenHash);
    session.accessTokenHash = null;
    return { ok: false, reason: 'expired' };
  }

  session.updatedAt = now;
  return { ok: true, session };
}

/**
 * Valida un refresh_token antes de rotarlo (para comprobar primero en BD si la API Key sigue activa).
 */
export async function findSessionByRefreshToken({
  refreshToken,
  clientId,
  clientSecret,
  resource,
  scope,
}) {
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
    return { ok: false, error: 'invalid_request', errorDescription: 'Missing refresh_token.' };
  }

  const now = Date.now();
  const tokenHash = hashToken(refreshToken.trim());
  const sessionId = refreshTokenIndex.get(tokenHash);
  if (!sessionId) {
    return { ok: false, error: 'invalid_grant', errorDescription: 'Invalid or expired refresh_token.' };
  }

  const session = sessions.get(sessionId);
  if (!session || session.refreshExpiresAt <= now) {
    removeSessionRecord(sessionId);
    return { ok: false, error: 'invalid_grant', errorDescription: 'Refresh token has expired.' };
  }

  if (clientId && session.clientId !== clientId) {
    return { ok: false, error: 'invalid_grant', errorDescription: 'Client mismatch for refresh_token.' };
  }

  const client = await findOAuthClient(session.clientId);
  if (client && !client.isCimdClient && !verifyClientSecret(client, clientSecret)) {
    return { ok: false, statusCode: 401, error: 'invalid_client', errorDescription: 'Client authentication failed.' };
  }

  const normalizedResource = normalizeResourceUri(resource);
  if (normalizedResource && session.resource && normalizedResource !== session.resource) {
    return { ok: false, error: 'invalid_target', errorDescription: 'Resource indicator mismatch.' };
  }

  if (typeof scope === 'string' && scope.trim()) {
    const grantedSet = new Set(session.scope.split(/\s+/));
    const requestedScopes = scope.trim().split(/\s+/).filter(Boolean);
    if (requestedScopes.some((s) => !grantedSet.has(s))) {
      return { ok: false, error: 'invalid_scope', errorDescription: 'Requested scope exceeds granted scope.' };
    }
  }

  return { ok: true, session };
}

/**
 * Rota access_token y refresh_token sobre una sesión virtual existente (OAuth 2.1 rotation).
 */
export async function rotateVirtualSessionTokens(sessionId, { scope } = {}) {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  const now = Date.now();
  if (session.accessTokenHash) {
    accessTokenIndex.delete(session.accessTokenHash);
  }
  if (session.refreshTokenHash) {
    refreshTokenIndex.delete(session.refreshTokenHash);
  }

  const newAccessToken = `mcp_at_${generateToken()}`;
  const newRefreshToken = `mcp_rt_${generateToken()}`;
  const newAccessHash = hashToken(newAccessToken);
  const newRefreshHash = hashToken(newRefreshToken);

  session.accessTokenHash = newAccessHash;
  session.accessExpiresAt = now + ACCESS_TOKEN_TTL_SECONDS * 1000;
  session.refreshTokenHash = newRefreshHash;
  session.refreshExpiresAt = now + REFRESH_TOKEN_TTL_SECONDS * 1000;
  session.updatedAt = now;

  accessTokenIndex.set(newAccessHash, session.id);
  refreshTokenIndex.set(newRefreshHash, session.id);

  const effectiveScope =
    typeof scope === 'string' && scope.trim()
      ? scope.trim().split(/\s+/).filter(Boolean).join(' ')
      : session.scope;

  return {
    session,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: effectiveScope,
  };
}

export async function deleteVirtualSession(sessionId) {
  return removeSessionRecord(sessionId);
}

export async function revokeOAuthToken(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken.trim()) {
    return false;
  }
  const tokenHash = hashToken(rawToken.trim());
  const sessionId = refreshTokenIndex.get(tokenHash) || accessTokenIndex.get(tokenHash);
  if (!sessionId) {
    return false;
  }
  return removeSessionRecord(sessionId);
}

export async function revokeVirtualSessionsByApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return 0;
  const normalized = apiKey.trim().toLowerCase();
  let removed = 0;
  for (const [sessionId, session] of sessions.entries()) {
    if (session.apiKey === normalized) {
      removeSessionRecord(sessionId);
      removed += 1;
    }
  }
  return removed;
}

export function resetOAuthMemoryStore() {
  clients.clear();
  authCodes.clear();
  sessions.clear();
  accessTokenIndex.clear();
  refreshTokenIndex.clear();
}
