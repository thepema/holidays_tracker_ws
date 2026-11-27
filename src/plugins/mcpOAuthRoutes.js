import { createRateLimitPreHandler } from '../lib/rateLimiter.js';
import { authenticateMcpApiKey } from '../services/sessionService.js';
import {
  MCP_DEFAULT_SCOPE,
  consumeAuthorizationCode,
  createAuthorizationCode,
  createVirtualSession,
  deleteVirtualSession,
  findOAuthClient,
  findSessionByRefreshToken,
  isValidPkceChallenge,
  isValidRedirectUri,
  normalizeResourceUri,
  registerOAuthClient,
  revokeOAuthToken,
  rotateVirtualSessionTokens,
} from '../services/mcpOAuthStore.js';

const SAFE_HOST_REGEX = /^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$/;

export function resolvePublicBaseUrl(request) {
  const configured = String(
    process.env.MCP_PUBLIC_URL || process.env.PUBLIC_API_URL || '',
  )
    .trim()
    .replace(/\/+$/, '');
  if (configured) {
    return configured;
  }

  const rawProto = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : request.protocol || 'http';

  const rawHost = String(
    request.headers['x-forwarded-host'] || request.headers.host || 'localhost:3000',
  )
    .split(',')[0]
    .trim();
  const host = SAFE_HOST_REGEX.test(rawHost) ? rawHost : 'localhost:3000';

  return `${proto}://${host}`;
}

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[^\x20\x21\x23-\x5B\x5D-\x7E]/g, '');
}

export function buildMcpWwwAuthenticateHeader(request, challenge = {}) {
  const baseUrl = resolvePublicBaseUrl(request);
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;
  const parts = [
    'realm="MCP Server"',
    `resource_metadata="${resourceMetadataUrl}"`,
  ];
  if (challenge.error) {
    parts.push(`error="${sanitizeHeaderValue(challenge.error)}"`);
  }
  if (challenge.errorDescription) {
    parts.push(`error_description="${sanitizeHeaderValue(challenge.errorDescription)}"`);
  }
  parts.push(`scope="${MCP_DEFAULT_SCOPE}"`);
  return `Bearer ${parts.join(', ')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isMatchingMcpResource(requestedResource, baseUrl) {
  if (!requestedResource) return true;
  const normalizedRequested = normalizeResourceUri(requestedResource);
  if (!normalizedRequested) return false;
  const normalizedMcp = normalizeResourceUri(`${baseUrl}/mcp`);
  const normalizedBase = normalizeResourceUri(baseUrl);
  return normalizedRequested === normalizedMcp || normalizedRequested === normalizedBase;
}

function buildRedirectUrl(redirectUri, params = {}) {
  const target = new URL(redirectUri);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      target.searchParams.set(key, String(val));
    }
  }
  return target.toString();
}

function extractClientAuth(request, body = {}) {
  const authHeader = String(request.headers.authorization || '').trim();
  if (/^Basic\s+/i.test(authHeader)) {
    try {
      const encoded = authHeader.replace(/^Basic\s+/i, '').trim();
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sepIndex = decoded.indexOf(':');
      if (sepIndex !== -1) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, sepIndex)),
          clientSecret: decodeURIComponent(decoded.slice(sepIndex + 1)),
        };
      }
    } catch {
      // Si falla la cabecera Basic se evalúa como credencial inválida más adelante
    }
  }

  return {
    clientId: typeof body.client_id === 'string' ? body.client_id.trim() : '',
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : undefined,
  };
}

function setNoStoreHeaders(reply) {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
}

function setHtmlSecurityHeaders(reply) {
  setNoStoreHeaders(reply);
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
  );
}

function renderErrorPage({ title, message }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Holiday Tracker MCP</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6fb; color: #1e293b; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box; }
    .card { background: #ffffff; max-width: 440px; width: 100%; border-radius: 14px; padding: 28px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08); border: 1px solid #e2e8f0; }
    h1 { font-size: 1.2rem; margin: 0 0 12px; color: #b91c1c; }
    p { margin: 0; font-size: 0.95rem; line-height: 1.5; color: #475569; }
  </style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

function renderAuthorizePage({
  clientName,
  oauthParams,
  errorMessage = '',
}) {
  const hiddenInputs = Object.entries(oauthParams)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`,
    )
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conectar Agente IA · Holiday Tracker</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6fb; color: #0f172a; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box; }
    .card { background: #ffffff; max-width: 460px; width: 100%; border-radius: 16px; padding: 28px; box-shadow: 0 14px 36px rgba(15, 23, 42, 0.09); border: 1px solid #e2e8f0; }
    .badge { display: inline-block; font-size: 0.75rem; font-weight: 600; color: #1d4ed8; background: #dbeafe; padding: 4px 10px; border-radius: 999px; margin-bottom: 12px; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    .subtitle { margin: 0 0 18px; font-size: 0.92rem; color: #475569; line-height: 1.5; }
    .scope-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; font-size: 0.85rem; color: #334155; margin-bottom: 18px; }
    .scope-box strong { display: block; color: #0f172a; margin-bottom: 4px; }
    .alert { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 10px 12px; border-radius: 10px; font-size: 0.88rem; margin-bottom: 16px; }
    label { display: block; font-size: 0.88rem; font-weight: 600; margin-bottom: 6px; color: #1e293b; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 11px 12px; font-size: 0.95rem; border: 1px solid #cbd5e1; border-radius: 10px; outline: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    input[type="password"]:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15); }
    .hint { font-size: 0.8rem; color: #64748b; margin: 8px 0 20px; line-height: 1.4; }
    .actions { display: flex; gap: 10px; }
    button { flex: 1; padding: 11px 16px; font-size: 0.93rem; font-weight: 600; border-radius: 10px; cursor: pointer; border: none; }
    .btn-primary { background: #2563eb; color: #ffffff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    .btn-secondary:hover { background: #e2e8f0; }
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">MCP · OAuth 2.1</span>
    <h1>Autorizar a ${escapeHtml(clientName)}</h1>
    <p class="subtitle">
      Este agente solicita conectarse a tu cuenta de <strong>Holiday Tracker</strong> para consultar tu perfil, festivos y gestionar tus días de vacaciones.
    </p>
    <div class="scope-box">
      <strong>Permiso solicitado (<code>mcp:vacations</code>)</strong>
      Consultar y gestionar únicamente tus propias vacaciones mientras tu sesión permanezca activa.
    </div>
    ${errorMessage ? `<div class="alert" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
    <form method="POST" action="/oauth/authorize" autocomplete="off">
      ${hiddenInputs}
      <label for="api_key">Tu API Token personal</label>
      <input
        id="api_key"
        name="api_key"
        type="password"
        placeholder="Pega aquí tu API Key de 64 caracteres..."
        minlength="64"
        maxlength="64"
        autofocus
      />
      <p class="hint">
        Puedes copiar tu API Token desde el portal web de Holiday Tracker en el botón <strong>Agente IA (MCP)</strong>.
      </p>
      <div class="actions">
        <button type="submit" name="decision" value="deny" class="btn-secondary" formnovalidate>Cancelar</button>
        <button type="submit" name="decision" value="approve" class="btn-primary">Autorizar acceso</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

const registerRateLimit = createRateLimitPreHandler({
  bucket: 'route:oauth:register',
  maxRequests: 25,
  windowMs: 10 * 60 * 1000,
  errorMessage: 'Demasiados registros de clientes OAuth desde esta IP.',
});

const authorizePostRateLimit = createRateLimitPreHandler({
  bucket: 'route:oauth:authorize:post',
  maxRequests: 10,
  windowMs: 10 * 60 * 1000,
  errorMessage: 'Demasiados intentos de autorización MCP.',
});

const tokenRateLimit = createRateLimitPreHandler({
  bucket: 'route:oauth:token',
  maxRequests: 40,
  windowMs: 5 * 60 * 1000,
  errorMessage: 'Demasiadas peticiones al endpoint de tokens OAuth.',
});

async function resolveValidatedAuthorizeContext(params, baseUrl) {
  const clientId = typeof params.client_id === 'string' ? params.client_id.trim() : '';
  const requestedRedirectUri =
    typeof params.redirect_uri === 'string' ? params.redirect_uri.trim() : '';

  if (!clientId) {
    return {
      fatalError: {
        title: 'Solicitud OAuth incompleta',
        message: 'Falta el parámetro obligatorio client_id.',
      },
    };
  }

  const client = await findOAuthClient(clientId, requestedRedirectUri);
  if (!client) {
    return {
      fatalError: {
        title: 'Cliente OAuth no reconocido',
        message:
          'El cliente no está registrado o su sesión en memoria expiró tras un reinicio. Reconecta el servidor MCP en tu agente para que vuelva a registrarse automáticamente.',
      },
    };
  }

  let redirectUri = requestedRedirectUri;
  if (!redirectUri) {
    if (client.redirectUris.length === 1) {
      redirectUri = client.redirectUris[0];
    } else {
      return {
        fatalError: {
          title: 'redirect_uri requerido',
          message: 'El cliente debe especificar un redirect_uri registrado.',
        },
      };
    }
  } else if (!isValidRedirectUri(redirectUri) || !client.redirectUris.includes(redirectUri)) {
    return {
      fatalError: {
        title: 'redirect_uri no permitido',
        message: 'La dirección de retorno (redirect_uri) no coincide con la registrada por el cliente.',
      },
    };
  }

  const state = typeof params.state === 'string' ? params.state : '';
  const responseType = typeof params.response_type === 'string' ? params.response_type.trim() : '';
  const codeChallenge =
    typeof params.code_challenge === 'string' ? params.code_challenge.trim() : '';
  const codeChallengeMethod =
    typeof params.code_challenge_method === 'string' && params.code_challenge_method.trim()
      ? params.code_challenge_method.trim()
      : '';
  const scope = typeof params.scope === 'string' && params.scope.trim()
    ? params.scope.trim()
    : MCP_DEFAULT_SCOPE;
  const resource = typeof params.resource === 'string' && params.resource.trim()
    ? params.resource.trim()
    : `${baseUrl}/mcp`;

  if (responseType !== 'code') {
    return {
      redirectError: buildRedirectUrl(redirectUri, {
        error: 'unsupported_response_type',
        error_description: 'Only response_type=code is supported.',
        state,
        iss: baseUrl,
      }),
    };
  }

  if (!isValidPkceChallenge(codeChallenge, codeChallengeMethod)) {
    return {
      redirectError: buildRedirectUrl(redirectUri, {
        error: 'invalid_request',
        error_description: 'PKCE code_challenge with code_challenge_method=S256 is required.',
        state,
        iss: baseUrl,
      }),
    };
  }

  if (!isMatchingMcpResource(resource, baseUrl)) {
    return {
      redirectError: buildRedirectUrl(redirectUri, {
        error: 'invalid_target',
        error_description: 'Invalid resource indicator for this MCP server.',
        state,
        iss: baseUrl,
      }),
    };
  }

  return {
    client,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    scope,
    resource: `${baseUrl}/mcp`,
    oauthParams: {
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope,
      state,
      resource: `${baseUrl}/mcp`,
    },
  };
}

export default async function mcpOAuthRoutes(app) {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const parsed = Object.fromEntries(new URLSearchParams(String(body || '')).entries());
          done(null, parsed);
        } catch (err) {
          done(err, undefined);
        }
      },
    );
  }

  const protectedResourceHandler = async (request, reply) => {
    const baseUrl = resolvePublicBaseUrl(request);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: [MCP_DEFAULT_SCOPE],
      bearer_methods_supported: ['header'],
    };
  };

  const authorizationServerMetadataHandler = async (request, reply) => {
    const baseUrl = resolvePublicBaseUrl(request);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      scopes_supported: [MCP_DEFAULT_SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
        'client_secret_basic',
      ],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    };
  };

  app.get(
    '/.well-known/oauth-protected-resource',
    { schema: { hide: true } },
    protectedResourceHandler,
  );
  app.get(
    '/.well-known/oauth-protected-resource/mcp',
    { schema: { hide: true } },
    protectedResourceHandler,
  );
  app.get(
    '/.well-known/oauth-authorization-server',
    { schema: { hide: true } },
    authorizationServerMetadataHandler,
  );
  app.get(
    '/.well-known/openid-configuration',
    { schema: { hide: true } },
    authorizationServerMetadataHandler,
  );

  app.post(
    '/oauth/register',
    {
      preHandler: registerRateLimit,
      schema: { tags: ['MCP OAuth 2.1'], summary: 'Registro dinámico de clientes MCP (RFC 7591)' },
    },
    async (request, reply) => {
      setNoStoreHeaders(reply);
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      const result = await registerOAuthClient(body);
      if (!result.ok) {
        return reply.code(400).send({
          error: result.error,
          error_description: result.errorDescription,
        });
      }
      return reply.code(201).send(result.client);
    },
  );

  app.get(
    '/oauth/authorize',
    { schema: { hide: true } },
    async (request, reply) => {
      setHtmlSecurityHeaders(reply);
      const baseUrl = resolvePublicBaseUrl(request);
      const resolved = await resolveValidatedAuthorizeContext(request.query || {}, baseUrl);

      if (resolved.fatalError) {
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(renderErrorPage(resolved.fatalError));
      }

      if (resolved.redirectError) {
        return reply.redirect(resolved.redirectError, 302);
      }

      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(
          renderAuthorizePage({
            clientName: resolved.client.clientName,
            oauthParams: resolved.oauthParams,
          }),
        );
    },
  );

  app.post(
    '/oauth/authorize',
    {
      preHandler: authorizePostRateLimit,
      schema: { hide: true },
    },
    async (request, reply) => {
      setHtmlSecurityHeaders(reply);
      const baseUrl = resolvePublicBaseUrl(request);
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      const resolved = await resolveValidatedAuthorizeContext(body, baseUrl);

      if (resolved.fatalError) {
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(renderErrorPage(resolved.fatalError));
      }

      if (resolved.redirectError) {
        return reply.redirect(resolved.redirectError, 302);
      }

      if (String(body.decision || '').trim() === 'deny') {
        return reply.redirect(
          buildRedirectUrl(resolved.redirectUri, {
            error: 'access_denied',
            error_description: 'The user denied the authorization request.',
            state: resolved.state,
            iss: baseUrl,
          }),
          302,
        );
      }

      const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
      if (!apiKey) {
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(
            renderAuthorizePage({
              clientName: resolved.client.clientName,
              oauthParams: resolved.oauthParams,
              errorMessage: 'Debes introducir tu API Token personal para autorizar al agente.',
            }),
          );
      }

      const mcpUser = await authenticateMcpApiKey(apiKey);
      if (!mcpUser) {
        return reply
          .code(401)
          .type('text/html; charset=utf-8')
          .send(
            renderAuthorizePage({
              clientName: resolved.client.clientName,
              oauthParams: resolved.oauthParams,
              errorMessage:
                'API Token no válido o tu sesión de usuario en Holiday Tracker no está activa.',
            }),
          );
      }

      const code = await createAuthorizationCode({
        clientId: resolved.client.clientId,
        redirectUri: resolved.redirectUri,
        codeChallenge: resolved.codeChallenge,
        codeChallengeMethod: 'S256',
        resource: resolved.resource,
        scope: resolved.scope,
        apiKey,
        userId: mcpUser.id,
      });

      return reply.redirect(
        buildRedirectUrl(resolved.redirectUri, {
          code,
          state: resolved.state,
          iss: baseUrl,
        }),
        302,
      );
    },
  );

  app.post(
    '/oauth/token',
    {
      preHandler: tokenRateLimit,
      schema: { tags: ['MCP OAuth 2.1'], summary: 'Canje de código PKCE y rotación de refresh_token' },
    },
    async (request, reply) => {
      setNoStoreHeaders(reply);
      const baseUrl = resolvePublicBaseUrl(request);
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      const grantType = typeof body.grant_type === 'string' ? body.grant_type.trim() : '';
      const { clientId, clientSecret } = extractClientAuth(request, body);

      if (!clientId) {
        return reply.code(400).send({
          error: 'invalid_request',
          error_description: 'client_id is required.',
        });
      }

      if (body.resource && !isMatchingMcpResource(String(body.resource), baseUrl)) {
        return reply.code(400).send({
          error: 'invalid_target',
          error_description: 'Invalid resource indicator for this MCP server.',
        });
      }

      if (grantType === 'authorization_code') {
        const consumed = await consumeAuthorizationCode({
          code: body.code,
          clientId,
          clientSecret,
          redirectUri: typeof body.redirect_uri === 'string' ? body.redirect_uri.trim() : '',
          codeVerifier: typeof body.code_verifier === 'string' ? body.code_verifier.trim() : '',
          resource: typeof body.resource === 'string' ? body.resource.trim() : `${baseUrl}/mcp`,
        });

        if (!consumed.ok) {
          if (consumed.statusCode === 401) {
            reply.header('WWW-Authenticate', 'Basic realm="OAuth Token Endpoint"');
          }
          return reply.code(consumed.statusCode || 400).send({
            error: consumed.error,
            error_description: consumed.errorDescription,
          });
        }

        const mcpUser = await authenticateMcpApiKey(consumed.grant.apiKey);
        if (!mcpUser) {
          return reply.code(400).send({
            error: 'invalid_grant',
            error_description: 'Underlying user API key or session is no longer active.',
          });
        }

        const issued = await createVirtualSession({
          clientId: consumed.grant.clientId,
          userId: mcpUser.id,
          apiKey: consumed.grant.apiKey,
          scope: consumed.grant.scope,
          resource: consumed.grant.resource || `${baseUrl}/mcp`,
          authCodeHash: consumed.grant.codeHash,
        });

        return reply.code(200).send({
          access_token: issued.accessToken,
          token_type: issued.tokenType,
          expires_in: issued.expiresIn,
          refresh_token: issued.refreshToken,
          scope: issued.scope,
        });
      }

      if (grantType === 'refresh_token') {
        const lookup = await findSessionByRefreshToken({
          refreshToken: body.refresh_token,
          clientId,
          clientSecret,
          resource: typeof body.resource === 'string' ? body.resource.trim() : undefined,
          scope: typeof body.scope === 'string' ? body.scope.trim() : undefined,
        });

        if (!lookup.ok) {
          if (lookup.statusCode === 401) {
            reply.header('WWW-Authenticate', 'Basic realm="OAuth Token Endpoint"');
          }
          return reply.code(lookup.statusCode || 400).send({
            error: lookup.error,
            error_description: lookup.errorDescription,
          });
        }

        const mcpUser = await authenticateMcpApiKey(lookup.session.apiKey);
        if (!mcpUser) {
          await deleteVirtualSession(lookup.session.id);
          return reply.code(400).send({
            error: 'invalid_grant',
            error_description: 'Underlying user API key or session is no longer active.',
          });
        }

        const rotated = await rotateVirtualSessionTokens(lookup.session.id, {
          scope: body.scope,
        });
        if (!rotated) {
          return reply.code(400).send({
            error: 'invalid_grant',
            error_description: 'Session could not be refreshed.',
          });
        }

        return reply.code(200).send({
          access_token: rotated.accessToken,
          token_type: rotated.tokenType,
          expires_in: rotated.expiresIn,
          refresh_token: rotated.refreshToken,
          scope: rotated.scope,
        });
      }

      return reply.code(400).send({
        error: 'unsupported_grant_type',
        error_description: 'Supported grant_types are authorization_code and refresh_token.',
      });
    },
  );

  app.post(
    '/oauth/revoke',
    {
      preHandler: tokenRateLimit,
      schema: { tags: ['MCP OAuth 2.1'], summary: 'Revocar token virtual OAuth 2.1 (RFC 7009)' },
    },
    async (request, reply) => {
      setNoStoreHeaders(reply);
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      if (typeof body.token === 'string' && body.token.trim()) {
        await revokeOAuthToken(body.token.trim());
      }
      return reply.code(200).send({});
    },
  );
}
