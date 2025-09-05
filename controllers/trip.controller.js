// controllers/trip.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

router.post('/', auth, async (req, res) => {
  try {
    const { destination, start_date, end_date, budget, notes } = req.body;
    const userId = req.user.id;
    const [result] = await pool.query(
      'INSERT INTO trips (user_id, destination, start_date, end_date, budget, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, destination, start_date, end_date, budget || null, notes || null]
    );
    res.json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query('SELECT * FROM trips WHERE user_id = ? ORDER BY start_date DESC', [userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.user.id;
    const [rows] = await pool.query('SELECT * FROM trips WHERE id = ? AND user_id = ?', [id, userId]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.user.id;
    const { destination, start_date, end_date, budget, notes } = req.body;
    await pool.query(
      'UPDATE trips SET destination=?, start_date=?, end_date=?, budget=?, notes=? WHERE id=? AND user_id=?',
      [destination, start_date, end_date, budget, notes, id, userId]
    );
    res.json({ message: 'Actualizado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.user.id;
    await pool.query('DELETE FROM trips WHERE id=? AND user_id=?', [id, userId]);
    res.json({ message: 'Eliminado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;
