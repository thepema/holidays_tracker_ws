# API: endpoints y configuración

Los endpoints administrativos requieren `Authorization: Bearer <token>` obtenido en `POST /api/admin/login`. Los usuarios se autentican mediante la cookie `ht_session`, emitida al activar o recuperar su sesión. Las fechas se reciben como `YYYY-MM-DD`.

## Endpoints

- `POST /api/admin/login`: intercambia `ADMIN_PASSWORD` por un token Bearer válido durante 8 horas.
- `GET /api/usuarios` (administrador): obtiene todos los usuarios excluyendo los que tienen cargo de administrador (`Administrador`, `Administradora`, `admin`).
- `GET /api/usuarios/pendientes` (administrador): obtiene todos los datos de los usuarios a los que se les ha enviado la invitación (`estado = 'proceso'`) y aún no han completado la autenticación.
- `POST /api/usuarios` (administrador): `{ "nombre", "apellidos", "cargo", "email", "tipo_vacaciones" }`
- `POST /api/sesiones/invitaciones` (administrador): envía invitaciones a usuarios sin sesión autorizada.
- `POST /api/usuarios/:usuarioId/invitacion` (administrador): envía una invitación individual.
- `POST /api/sesiones/activar`: `{ "codigo": "..." }`; el código de un solo uso llega en el enlace del correo y se valida contra `request_token_hash`. Devuelve el usuario, el `token` de sesión (también emitido como cookie `ht_session`) y el `codigoRecuperacion`.
- `POST /api/sesiones/recuperar`: `{ "email": "...", "codigoRecuperacion": "..." }`; rota la cookie y devuelve el usuario, el nuevo `token` y el nuevo `codigoRecuperacion`.
- `POST /api/sesiones/solicitar`: el usuario con sesión solicita la suya; el administrador puede indicar `{ "usuarioId": 1 }`.
- `POST /api/sesiones/cerrar` (administrador): revoca la sesión y el código de recuperación del usuario indicado por `{ "usuarioId": 1 }`. Para volver a acceder se debe solicitar o enviar una nueva invitación.
- `GET /api/vacaciones` (usuario o administrador): el usuario consulta solo sus vacaciones. El administrador puede filtrar con `?usuarios=1&usuarios=2`; sin IDs devuelve todas.
- `POST /api/vacaciones`: `{ "fechas": ["2026-08-15", "2026-08-16"] }`; un usuario registra fechas para sí mismo; el administrador también debe enviar `usuarioId`. Las fechas duplicadas existentes se ignoran.

## Variables de entorno adicionales

Configura en el entorno de ejecución (por ejemplo, `/opt/.env`):

- `ADMIN_PASSWORD`: contraseña para iniciar sesión como administrador.
- `ADMIN_TOKEN_SECRET`: secreto aleatorio para firmar y validar tokens administrativos; no es el token Bearer y no se envía en las peticiones.
- `APP_URL`: URL pública del frontend, por ejemplo `https://holiday-tracker.maisonzaro.com`.
- `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`: datos del SMTP.
- `ADMIN_EMAIL`: dirección que recibe las solicitudes de nueva sesión.
- `FRONTEND_ORIGIN`: origen del frontend si no queda cubierto por los orígenes permitidos en `server.js`.

La sesión de usuario caduca tras 8 horas sin actividad. Los tokens de solicitud (`request_token_hash`), de sesión (`token_hash`) y de recuperación (`recovery_token_hash`) se guardan en la base de datos exclusivamente como SHA-256 (CHAR(64)). El código de recuperación se devuelve al cliente tras activar o recuperar la sesión.
