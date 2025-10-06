// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./controllers/auth.controller');
const userRoutes = require('./controllers/user.controller');
const tripRoutes = require('./controllers/trip.controller');
const locationRoutes = require('./controllers/location.controller');
const interestRoutes = require('./controllers/interest.controller');
const communityController = require('./controllers/community.controller');
const shareController = require('./controllers/share.controller');

const app = express();
app.use(cors({
  origin: '*', 
  credentials: true
}));
app.use(express.json());

// prefijo /api para separar de las rutas de React
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/interests', interestRoutes);
app.use('/api/friends', communityController);
app.use('/api/share', shareController);

const PORT = process.env.PORT || 5432;
app.listen(PORT, () => console.log(`Backend escuchando en http://localhost:${PORT}`));
