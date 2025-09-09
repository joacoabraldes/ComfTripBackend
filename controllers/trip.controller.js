// controllers/trip.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

router.post('/', auth, async (req, res) => {
  try {
    const { destination, start_date, end_date, budget, notes } = req.body;
    const userId = req.user.id;
    const result = await pool.query(
      'INSERT INTO trips (user_id, destination, start_date, end_date, budget, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [userId, destination, start_date || null, end_date || null, budget || null, notes || null]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM trips WHERE user_id = $1 ORDER BY start_date DESC', [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM trips WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!result.rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(result.rows[0]);
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
      'UPDATE trips SET destination=$1, start_date=$2, end_date=$3, budget=$4, notes=$5 WHERE id=$6 AND user_id=$7',
      [destination, start_date || null, end_date || null, budget || null, notes || null, id, userId]
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
    await pool.query('DELETE FROM trips WHERE id=$1 AND user_id=$2', [id, userId]);
    res.json({ message: 'Eliminado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;
