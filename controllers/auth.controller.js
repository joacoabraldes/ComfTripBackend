// controllers/auth.controller.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, nationality, birthdate } = req.body;
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(400).json({ message: 'Email en uso' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, phone, password_hash, nationality, birthdate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name, email, phone || null, hash, nationality || null, birthdate || null]
    );
    const userId = result.rows[0].id;
    const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: userId, name, email, phone, nationality, birthdate }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const rows = await pool.query('SELECT id, name, email, password_hash FROM users WHERE email = $1', [email]);
    if (!rows.rows.length) return res.status(400).json({ message: 'Credenciales inválidas' });
    const user = rows.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ message: 'Credenciales inválidas' });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

module.exports = router;
