// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');

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

// --- uploads estáticos (deben coincidir con social.controller.js) ---
const UPLOAD_ROOT =
  process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'comftrip_uploads');

// sirve /uploads/** desde UPLOAD_ROOT
app.use('/uploads', express.static(UPLOAD_ROOT));

// prefijo /api para separar de las rutas de React
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
app.listen(PORT, () =>
  console.log(`Backend escuchando en http://localhost:${PORT}`)
);
