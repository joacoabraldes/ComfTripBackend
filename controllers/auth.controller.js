// controllers/user.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const bcrypt = require('bcrypt');

const router = express.Router();

// List predefined interests
router.get('/interests', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, slug, title, description FROM interests');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

/*
  GET /users/:id
  - auth required
  - returns profile (id, name, email, phone, nationality, birthdate) and interests array
*/
router.get('/:id', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });

    const [userRows] = await pool.query(
      'SELECT id, name, email, phone, nationality, birthdate, created_at FROM users WHERE id = ?',
      [userId]
    );
    if (!userRows.length) return res.status(404).json({ message: 'No encontrado' });

    const [interests] = await pool.query(`
      SELECT i.id, i.title FROM interests i
      JOIN user_interests ui ON i.id = ui.interest_id
      WHERE ui.user_id = ?`, [userId]);

    res.json({ user: userRows[0], interests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

/*
  PUT /users/:id
  - auth required
  - fields accepted in body: { name, email, phone, nationality, birthdate }
  - prevents updating another user's profile
  - checks email uniqueness if email is being changed
*/
router.put('/:id', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });

    const { name, email, phone, nationality, birthdate } = req.body;

    // If email changed, ensure uniqueness
    if (email) {
      const [rows] = await pool.query('SELECT id FROM users WHERE email = ? AND id <> ?', [email, userId]);
      if (rows.length) return res.status(400).json({ message: 'Email en uso' });
    }

    await pool.query(
      `UPDATE users SET 
         name = ?, 
         email = ?, 
         phone = ?, 
         nationality = ?, 
         birthdate = ?
       WHERE id = ?`,
      [
        name || null,
        email || null,
        phone || null,
        nationality || null,
        birthdate || null,
        userId
      ]
    );

    // return updated user (fresh)
    const [updated] = await pool.query('SELECT id, name, email, phone, nationality, birthdate FROM users WHERE id = ?', [userId]);
    res.json({ message: 'Perfil actualizado', user: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

/*
  PATCH /users/:id/password
  - auth required
  - body: { currentPassword, newPassword }
  - verifies currentPassword, then replaces with hashed newPassword
*/
router.patch('/:id/password', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Faltan campos' });

    const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (!rows.length) return res.status(404).json({ message: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(400).json({ message: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);

    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

/*
  Save interests: POST /users/:id/interests
  expects { interestIds: [1,2,3] }
*/
router.post('/:id/interests', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });
    const { interestIds } = req.body;

    await pool.query('DELETE FROM user_interests WHERE user_id = ?', [userId]);

    if (interestIds && interestIds.length) {
      // Build values for bulk insert
      const values = interestIds.map(i => [userId, i]);
      await pool.query('INSERT INTO user_interests (user_id, interest_id) VALUES ?', [values]);
    }

    res.json({ message: 'Intereses actualizados' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;
