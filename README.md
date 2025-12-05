# ComfTrip Backend

Backend API para la aplicación ComfTrip.

## Configuración

### Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto con las siguientes variables:

#### Base de Datos
```env
# PostgreSQL
DATABASE_URL=postgresql://user:password@host:port/database
# O configuración por partes:
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=password
PGDATABASE=comftrip
```

#### Autenticación
```env
JWT_SECRET=tu_secreto_jwt_super_seguro
```

#### Email (Para recuperación de contraseña)
```env
# Habilitar/deshabilitar envío de emails (default: true)
EMAIL_ENABLED=true

# Configuración SMTP
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false  # true para puerto 465, false para otros
EMAIL_USER=tu_email@gmail.com
EMAIL_PASS=tu_contraseña_de_aplicacion
EMAIL_FROM=noreply@comftrip.com  # Email remitente (opcional, usa EMAIL_USER por defecto)
```

**Nota sobre Gmail:**
- Si usas Gmail, necesitas generar una "Contraseña de aplicación" en tu cuenta de Google
- Ve a: Google Account > Seguridad > Verificación en 2 pasos > Contraseñas de aplicaciones
- Usa esa contraseña en `EMAIL_PASS`, no tu contraseña normal

**Otros proveedores SMTP:**
- **SendGrid**: `EMAIL_HOST=smtp.sendgrid.net`, `EMAIL_PORT=587`, `EMAIL_USER=apikey`, `EMAIL_PASS=tu_api_key`
- **Mailgun**: `EMAIL_HOST=smtp.mailgun.org`, `EMAIL_PORT=587`
- **Outlook**: `EMAIL_HOST=smtp-mail.outlook.com`, `EMAIL_PORT=587`

#### Otros
```env
PORT=3000
UPLOAD_DIR=/ruta/a/uploads  # Opcional, usa temp por defecto
```

## Instalación

```bash
npm install
```

## Ejecución

### Desarrollo
```bash
npm run dev
```

### Producción
```bash
npm start
```

## Endpoints

Ver `API_DOCUMENTATION.md` para la documentación completa de la API.

### Autenticación

- `POST /api/auth/register` - Registro de usuario
- `POST /api/auth/login` - Inicio de sesión
- `POST /api/auth/forgot-password` - Solicitar código de recuperación
- `POST /api/auth/reset-password` - Restablecer contraseña con código

## Recuperación de Contraseña

El sistema de recuperación de contraseña funciona de la siguiente manera:

1. El usuario solicita recuperación con su email (`POST /api/auth/forgot-password`)
2. Se genera un código de 6 dígitos válido por 10 minutos
3. El código se envía por email al usuario
4. El usuario usa el código para restablecer su contraseña (`POST /api/auth/reset-password`)

**Importante:** Si el email no está configurado (`EMAIL_ENABLED=false` o faltan credenciales), el código se mostrará en los logs del servidor para desarrollo/debugging.

## Estructura del Proyecto

```
ComfTripBackend/
├── controllers/      # Controladores de rutas
├── services/         # Servicios (email, POI, routing, etc.)
├── middleware/       # Middleware (autenticación, etc.)
├── tests/           # Tests
├── schema.sql       # Esquema de base de datos
└── server.js        # Punto de entrada
```

