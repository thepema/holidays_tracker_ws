# Login de administración

Configura en el archivo `.env` del contenedor/servidor dos secretos que no deben guardarse en el repositorio:

```dotenv
ADMIN_PASSWORD=una-contraseña-larga-y-aleatoria
ADMIN_TOKEN_SECRET=un-secreto-aleatorio-de-al-menos-32-bytes
```

Genera valores independientes y robustos; por ejemplo, con `openssl rand -base64 32`. Tras cambiar variables de entorno, reinicia o vuelve a desplegar la aplicación.

## Obtener un token

Envía la contraseña al endpoint `POST /api/admin/login`:

```bash
curl -X POST https://TU_API/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"TU_ADMIN_PASSWORD"}'
```

Si es correcta, responde con `token`, `tokenType: "Bearer"` y `expiresIn` (28800 segundos). El token firmado expira en 8 horas.

## Usarlo en endpoints administrativos

Incluye el token obtenido en la cabecera `Authorization`:

```bash
curl -X POST https://TU_API/api/sesiones/invitaciones \
  -H 'Authorization: Bearer TU_TOKEN'
```

En Swagger (`/docs`), ejecuta primero `POST /api/admin/login`, copia el token de la respuesta, pulsa **Authorize** y pega el token (sin necesidad de escribir `Bearer` si Swagger lo añade automáticamente). Los endpoints de vacaciones que son de usuario siguen requiriendo la cookie de sesión `ht_session`; este token es exclusivamente para administración.

Protege el endpoint de login con HTTPS y, si está expuesto públicamente, limita intentos en el proxy/firewall. No registres ni compartas la contraseña o los tokens.
