# API: endpoints y configuración

Los endpoints administrativos requieren `Authorization: Bearer <ADMIN_API_KEY>`. Los endpoints de vacaciones y solicitud de nueva sesión requieren la cookie `ht_session`. Las fechas se reciben como `YYYY-MM-DD`.

## Endpoints

- `POST /api/usuarios` (administrador): `{ "nombre", "apellidos", "cargo", "email", "tipo_vacaciones" }`
- `POST /api/sesiones/invitaciones` (administrador): envía invitaciones a usuarios sin sesión autorizada.
- `POST /api/usuarios/:usuarioId/invitacion` (administrador): envía una invitación individual.
- `POST /api/sesiones/activar`: `{ "codigo": "..." }`; el código de un solo uso llega en el enlace del correo y se intercambia por una cookie.
- `POST /api/sesiones/recuperar`: `{ "email": "...", "codigoRecuperacion": "..." }`; rota la cookie y envía un nuevo código de recuperación por correo.
- `POST /api/sesiones/solicitar` (sesión iniciada): solicita una nueva sesión al administrador y cierra la sesión actual.
- `POST /api/sesiones/cerrar` (sesión iniciada): revoca la sesión.
- `GET /api/vacaciones` (sesión iniciada): consulta las vacaciones del usuario autenticado.
- `POST /api/vacaciones` (sesión iniciada): `{ "fechas": ["2026-08-15", "2026-08-16"] }`; crea las fechas para el usuario autenticado. Las fechas duplicadas existentes se ignoran.

## Variables de entorno adicionales

Configura en el entorno de ejecución (por ejemplo, `/opt/.env`):

- `ADMIN_API_KEY`: clave larga y aleatoria para las operaciones administrativas.
- `APP_URL`: URL pública del frontend, por ejemplo `https://holiday-tracker.maisonzaro.com`.
- `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`: datos del SMTP.
- `ADMIN_EMAIL`: dirección que recibe las solicitudes de nueva sesión.
- `FRONTEND_ORIGIN`: origen del frontend si no queda cubierto por los orígenes permitidos en `server.js`.

La sesión caduca tras 8 horas sin actividad. Los códigos de sesión y recuperación se guardan en la base de datos solo como SHA-256. El código de recuperación se entrega por email después del inicio de sesión y se rota en cada recuperación.
