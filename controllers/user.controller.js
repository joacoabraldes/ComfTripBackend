// controllers/user.controller.js 
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();
const bcrypt = require('bcrypt');

router.post('/register', async (req, res) => {
  const { name, email, password, nationality, birthdate } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Faltan campos obligatorios' });

  try {
    const password_hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (name, email, password_hash, nationality, birthdate) VALUES ($1, $2, $3, $4, $5)',
      [name, email, password_hash, nationality || null, birthdate || null]
    );
    res.json({ message: 'Usuario registrado correctamente' });
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      res.status(400).json({ error: 'El email ya está registrado' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Error en el servidor' });
    }
  }
});

// listar intereses predefinidos
router.get('/interests', async (req, res) => {
  const result = await pool.query('SELECT id, slug, title, description FROM interests ORDER BY id');
  res.json(result.rows);
});

// guardar intereses (body: { interestIds: [1,2,3] })
router.post('/:id/interests', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });
    const { interestIds } = req.body;
    await pool.query('DELETE FROM user_interests WHERE user_id = $1', [userId]);
    if (interestIds && interestIds.length) {
      // build parameterized VALUES list
      const params = [];
      const placeholders = interestIds.map((iid) => {
        params.push(userId, iid);
        const len = params.length;
        return `($${len-1}, $${len})`;
      });
      const sql = `INSERT INTO user_interests (user_id, interest_id) VALUES ${placeholders.join(',')}`;
      await pool.query(sql, params);
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
    const userRes = await pool.query('SELECT id, name, email, phone, nationality, birthdate FROM users WHERE id = $1', [userId]);
    if (!userRes.rows.length) return res.status(404).json({ message: 'No encontrado' });

    const interestsRes = await pool.query(`
      SELECT i.id, i.title FROM interests i
      JOIN user_interests ui ON i.id = ui.interest_id
      WHERE ui.user_id = $1`, [userId]);

    res.json({ user: userRes.rows[0], interests: interestsRes.rows });
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
      'UPDATE users SET name=$1, email=$2, phone=$3, nationality=$4, birthdate=$5 WHERE id=$6',
      [name, email, phone || null, nationality || null, birthdate || null, userId]
    );
    // optionally return updated user
    const updated = await pool.query('SELECT id, name, email, phone, nationality, birthdate FROM users WHERE id = $1', [userId]);
    res.json({ message: 'Perfil actualizado', user: updated.rows[0] });
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      res.status(400).json({ error: 'El email ya está registrado' });
    } else {
      console.error(err);
      res.status(500).json({ message: 'Error' });
    }
  }
});

// cambiar contraseña
router.put('/:id/password', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ message: 'No autorizado' });
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ message: 'Faltan campos obligatorios' });
    const rows = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!rows.rows.length) return res.status(404).json({ message: 'Usuario no encontrado' });
    const ok = await bcrypt.compare(oldPassword, rows.rows[0].password_hash);
    if (!ok) return res.status(400).json({ message: 'Contraseña actual incorrecta' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, userId]);
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;

  //