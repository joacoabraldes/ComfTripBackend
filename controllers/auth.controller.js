// controllers/auth.controller.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * REGISTER
 * Accepts: { name, username, email, phone, password, nationality, birthdate }
 * - username is optional but recommended.
 * - we check both email and username uniqueness.
 */
router.post('/register', async (req, res) => {
  try {
    const { name, username, email, phone, password, nationality, birthdate } = req.body;

    if (!email && !username) {
      return res.status(400).json({ message: 'Email o username requerido' });
    }
    if (!password) {
      return res.status(400).json({ message: 'Password requerido' });
    }

    // normalize for checks
    const emailNorm = email ? email.trim().toLowerCase() : null;
    const usernameNorm = username ? username.trim() : null;

    // check email uniqueness
    if (emailNorm) {
      const existingEmail = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [emailNorm]);
      if (existingEmail.rows.length) return res.status(400).json({ message: 'Email en uso' });
    }

    // check username uniqueness (case-insensitive)
    if (usernameNorm) {
      const existingUser = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [usernameNorm]);
      if (existingUser.rows.length) return res.status(400).json({ message: 'Nombre de usuario en uso' });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (name, username, email, phone, password_hash, nationality, birthdate)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, username, email`,
      [name || null, usernameNorm, emailNorm, phone || null, hash, nationality || null, birthdate || null]
    );

    const user = result.rows[0];
    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        phone: phone || null,
        nationality: nationality || null,
        birthdate: birthdate || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/**
 * LOGIN
 * Accepts: { identifier, password }
 * - identifier can be username OR email (we search username first).
 * - we use case-insensitive lookups.
 */
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ message: 'Credenciales inválidas' });

    const id = identifier.trim();

    // 1) Try find by username (case-insensitive)
    let rows = await pool.query(
      `SELECT id, name, username, email, password_hash
       FROM users
       WHERE LOWER(username) = LOWER($1)
       LIMIT 1`,
      [id]
    );

    // 2) If not found by username, try by email (case-insensitive)
    if (!rows.rows.length) {
      rows = await pool.query(
        `SELECT id, name, username, email, password_hash
         FROM users
         WHERE LOWER(email) = LOWER($1)
         LIMIT 1`,
        [id.toLowerCase()]
      );
    }

    if (!rows.rows.length) {
      // generic failure (don't leak whether identifier exists)
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    const user = rows.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ message: 'Credenciales inválidas' });

    const token = signToken(user);
    res.json({ token, user: { id: user.id, name: user.name, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

module.exports = router;



