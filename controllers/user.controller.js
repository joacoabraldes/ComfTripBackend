// controllers/user.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();
const bcrypt = require('bcrypt');

exports.register = async (req, res) => {
  const { name, email, password, nationality, birthdate } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Faltan campos obligatorios' });

  try {
    const password_hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (name, email, password_hash, nationality, birthdate) VALUES (?, ?, ?, ?, ?)',
      [name, email, password_hash, nationality || null, birthdate || null]
    );
    res.json({ message: 'Usuario registrado correctamente' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'El email ya está registrado' });
    } else {
      res.status(500).json({ error: 'Error en el servidor' });
    }
  }
};

// listar intereses predefinidos
router.get('/interests', async (req, res) => {
  const [rows] = await pool.query('SELECT id, slug, title, description FROM interests');
  res.json(rows);
});

// guardar intereses (body: { interestIds: [1,2,3] })
router.post('/:id/interests', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });
    const { interestIds } = req.body;
    await pool.query('DELETE FROM user_interests WHERE user_id = ?', [userId]);
    if (interestIds && interestIds.length) {
      const values = interestIds.map(i => [userId, i]);
      await pool.query('INSERT INTO user_interests (user_id, interest_id) VALUES ?', [values]);
    }
    res.json({ message: 'Intereses actualizados' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

// obtener perfil con intereses
router.get('/:id', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });
    const [userRows] = await pool.query('SELECT id, name, email, phone, nationality, birthdate FROM users WHERE id = ?', [userId]);
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

// editar perfil
router.put('/:id', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });
    const { name, email, phone, nationality, birthdate } = req.body;
    await pool.query(
      'UPDATE users SET name=?, email=?, phone=?, nationality=?, birthdate=? WHERE id=?',
      [name, email, phone || null, nationality || null, birthdate || null, userId]
    );
    res.json({ message: 'Perfil actualizado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'El email ya está registrado' });
    } else {
      console.error(err);
      res.status(500).json({ message: 'Error' });
    }
  }
});

// cambiar contraseña z
router.put('/:id/password', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ message: 'Faltan campos obligatorios' });
    const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (!rows.length) return res.status(404).json({ message: 'Usuario no encontrado' });
    const ok = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!ok) return res.status(400).json({ message: 'Contraseña actual incorrecta' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=? WHERE id=?', [newHash, userId]);
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;
