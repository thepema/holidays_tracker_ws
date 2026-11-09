# holidays_tracker_ws

API para consultar vacaciones creada con Node.js, Fastify y PostgreSQL.

## Requisitos

- Node.js 20 o superior
- npm
- Acceso de red a PostgreSQL

## Instalación y ejecución local

```bash
npm install
cp .env.example .env
```

En `.env`, establece `DB_HOST` con la IP o el nombre DNS del VPS accesible desde tu ordenador y configura las credenciales de la base `holidaysTrackerDB`. PostgreSQL escucha por defecto en el puerto `5432`. No subas `.env` a Git.

```bash
npm run dev
```

La API queda disponible en `http://localhost:3000`. Para cambiar el puerto, define `PORT`.

## Endpoint

- `GET /` — responde con `{"message":"¡Hola, mundo!"}`.
- `GET /api/vacaciones` — devuelve las vacaciones con los datos del usuario, excluyendo cargos `Administrador` y `Administradora`.

La respuesta del endpoint de vacaciones tiene la forma `{"vacaciones":[...]}`. Si PostgreSQL no está configurado o no es accesible, responde con HTTP `503`.

## Despliegue en Docker/Jenkins

Las instancias de `develop` y `main` se conectan a las redes Docker `proxy` y `backend-network`. Configura en Jenkins las variables `DB_HOST`, `DB_USER` y `DB_PASSWORD` (la contraseña como credencial secreta); `DB_HOST` debe ser el hostname/IP del PostgreSQL alcanzable desde la red `backend-network`. La base de datos debe aceptar conexiones desde esa red. El pipeline define `DB_PORT=5432` y `DB_NAME=holidaysTrackerDB` para los contenedores.

No se incluyen credenciales reales en el repositorio. Como la contraseña se compartió en una conversación, cámbiala y guarda la nueva en el gestor de credenciales de Jenkins y en tu `.env` local.
