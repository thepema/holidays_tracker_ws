# holidays_tracker_ws

API para consultar las vacaciones desde PostgreSQL usando Node.js y Fastify.

## Requisitos

- Node.js 20 o superior
- npm
- PostgreSQL accesible desde esta máquina

## Configuración y ejecución local

Instala dependencias:

```bash
npm install
```

La aplicación carga `.env` desde la raíz del proyecto. Si el archivo existente está en otra ubicación, indícala con `ENV_FILE`; por ejemplo, si se encuentra en `/opt/.env`:

```bash
ENV_FILE=/opt/.env PORT=8080 npm run dev
```

En PowerShell:

```powershell
$env:ENV_FILE = "/opt/.env"
$env:PORT = "8080"
npm run dev
```

El archivo debe definir `DB_HOST`, `DB_NAME`, `DB_USER` y `DB_PASSWORD`. `DB_PORT` es opcional y por defecto es `5432`. No guardes ni publiques credenciales en el repositorio.

La API queda disponible en `http://localhost:8080`.

## Endpoint de vacaciones

`GET /api/vacaciones` devuelve las vacaciones junto con los datos del usuario asociado:

```json
{
  "vacaciones": [
    {
      "id": 1,
      "usuarioId": 1,
      "anio": 2026,
      "fecha": "2026-08-15T00:00:00.000Z",
      "nombre": "Ana",
      "apellidos": "Pérez",
      "cargo": "Empleado"
    }
  ]
}
```

Prueba con:

```bash
curl http://localhost:8080/api/vacaciones
```

El servidor permite CORS para `http://localhost:4200` y `http://127.0.0.1:4200`, además de los subdominios HTTPS de `maisonzaro.com`. Si no se puede consultar la base de datos, la API responde HTTP `503` sin exponer detalles internos.
