require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os'); // si querés usar tmp en algún momento
const emailService = require('./services/email.service');

const authRoutes = require('./controllers/auth.controller');
const userRoutes = require('./controllers/user.controller');
const tripRoutes = require('./controllers/trip.controller');
const locationRoutes = require('./controllers/location.controller');
const interestRoutes = require('./controllers/interest.controller');
const communityController = require('./controllers/community.controller');
const shareController = require('./controllers/share.controller');
const flightController = require('./controllers/flight.controller');
const socialRouter = require('./controllers/social.controller');

const app = express();

app.use(
  cors({
    origin: '*',
    credentials: true,
  })
);

app.use(express.json());

/**
 * === UPLOADS ESTÁTICOS ===
 * Usamos SIEMPRE el mismo root en todo el backend.
 * Carpeta física: <raíz del proyecto>/uploads
 */
const UPLOAD_ROOT =
  process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

// /uploads/** → sirve archivos desde UPLOAD_ROOT
app.use('/uploads', express.static(UPLOAD_ROOT));

// --- Rutas API (todas con prefijo /api) ---
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/interests', interestRoutes);
app.use('/api/friends', communityController);
app.use('/api/share', shareController);
app.use('/api/flights', flightController);
app.use('/api/social', socialRouter);

const PORT = process.env.PORT || 5432;

// Verify email configuration on startup
(async () => {
  await emailService.verifyEmailConfig();
})();

app.listen(PORT, () =>
  console.log(`Backend escuchando en http://localhost:${PORT}`)
);
