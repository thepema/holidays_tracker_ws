# API: endpoints y configuración

Los endpoints administrativos requieren `Authorization: Bearer <token>` obtenido en `POST /api/admin/login`. Los usuarios se autentican mediante la cookie `ht_session`, emitida al activar o recuperar su sesión. Las fechas se reciben como `YYYY-MM-DD`.

## Endpoints

- `POST /api/admin/login`: intercambia `ADMIN_PASSWORD` por un token Bearer válido durante 8 horas.
- `GET /api/usuarios` (administrador): obtiene todos los usuarios excluyendo los que tienen cargo de administrador (`Administrador`, `Administradora`, `admin`).
- `GET /api/usuarios/pendientes` (administrador): obtiene todos los datos de los usuarios a los que se les ha enviado la invitación (`estado = 'proceso'`) y aún no han completado la autenticación.
- `POST /api/usuarios` (administrador): `{ "nombre", "apellidos", "cargo", "email", "tipo_vacaciones" }`
- `PATCH /api/usuarios/:usuarioId` (administrador): actualiza parcialmente un usuario existente (`{ nombre?, apellidos?, cargo?, email?, tipo_vacaciones? }`).
- `POST /api/sesiones/invitaciones` (administrador): envía invitaciones masivas a usuarios sin sesión activa que no tengan ya una invitación en proceso.
- `POST /api/usuarios/:usuarioId/invitacion` (administrador): envía una invitación individual a `${APP_URL}/invitacion/<request_token>` (si el usuario ya está en estado `proceso`, no se vuelve a enviar y responde 409).
- `GET /api/sesiones/me`: verifica la sesión activa del usuario mediante la cookie `ht_session` (o cabecera `X-Session-Token`) y devuelve `{ autenticado: true, usuario }`.
- `POST /api/sesiones/activar`: acepta `{ "codigo": "..." }` o `{ "request_token": "..." }` (o vía URL `/sesiones/activar/:codigo`). Borra `request_token_hash` en BD, genera `token_hash` (cookie `ht_session`) y devuelve usuario, `token` y `codigoRecuperacion`.
- `POST /api/sesiones/recuperar`: `{ "codigoRecuperacion": "..." }` (y opcionalmente `email`); verifica el token de recuperación y devuelve la cookie `ht_session` junto con el `usuario` y el `token`.
- `POST /api/sesiones/solicitar`: permite solicitar sesión desde la pantalla landing enviando `{ "nombre": "...", "email": "..." }` (cruza los datos con la BD y registra la sesión como `solicitado`), o por parte del administrador indicando `{ "usuarioId": 1 }`.
- `POST /api/sesiones/cerrar` (administrador): revoca la sesión y el código de recuperación del usuario indicado por `{ "usuarioId": 1 }`. Para volver a acceder se debe solicitar o enviar una nueva invitación.
- `GET /api/vacaciones` (usuario o administrador): el usuario consulta solo sus vacaciones. El administrador puede filtrar con `?usuarios=1&usuarios=2`; sin IDs devuelve todas.
- `POST /api/vacaciones`: `{ "fechas": ["2026-08-15", "2026-08-16"] }`; un usuario registra fechas para sí mismo; el administrador también debe enviar `usuarioId`. Las fechas duplicadas existentes se ignoran.
- `PATCH /api/vacaciones/:vacacionId`: `{ "fecha": "2026-11-25" }`; modifica la fecha de un día de vacaciones pedido siempre que la fecha original y la nueva fecha aún no hayan pasado y no esté duplicada.
- `DELETE /api/vacaciones/:vacacionId`: cancela/elimina un día de vacaciones pedido cuya fecha aún no haya pasado.

## Variables de entorno adicionales

Configura en el entorno de ejecución (por ejemplo, `/opt/.env`):

- `ADMIN_PASSWORD`: contraseña para iniciar sesión como administrador.
- `ADMIN_TOKEN_SECRET`: secreto aleatorio para firmar y validar tokens administrativos; no es el token Bearer y no se envía en las peticiones.
- `APP_URL`: URL pública del frontend, por ejemplo `https://holiday-tracker.maisonzaro.com`.
- `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`: datos del SMTP.
- `ADMIN_EMAIL`: dirección que recibe las solicitudes de nueva sesión.
- `FRONTEND_ORIGIN`: origen del frontend si no queda cubierto por los orígenes permitidos en `server.js`.

La sesión de usuario caduca tras 8 horas sin actividad. Los tokens de solicitud (`request_token_hash`), de sesión (`token_hash`) y de recuperación (`recovery_token_hash`) se guardan en la base de datos exclusivamente como SHA-256 (CHAR(64)). El código de recuperación se devuelve al cliente tras activar o recuperar la sesión.
