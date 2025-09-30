// controllers/itinerary.controller.js
const express = require('express');
const pool = require('../db'); // your existing pg pool
const auth = require('../middleware/auth');
const router = express.Router();

/**
 * POST /trips/:id/generate
 * Enqueue itinerary generation for trip (creates row in itinerary_generations)
 */
router.post('/:id/generate', auth, async (req, res) => {
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;

    // validate ownership
    const tripRes = await pool.query('SELECT id, user_id, destination, start_date, end_date FROM trips WHERE id = $1', [tripId]);
    if (!tripRes.rows.length) return res.status(404).json({ message: 'Trip not found' });
    if (tripRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'Not authorized' });

    // insert generation row
    const insert = await pool.query(
      `INSERT INTO itinerary_generations (trip_id, user_id, status, model) VALUES ($1,$2,$3,$4) RETURNING id, status, created_at`,
      [tripId, userId, 'pending', process.env.HF_GEN_MODEL || 'hf-default']
    );

    const gen = insert.rows[0];

    // Return generation id. The worker (run separately) will pick pending jobs automatically.
    return res.status(201).json({ generationId: gen.id, status: gen.status });
  } catch (err) {
    console.error('POST /trips/:id/generate error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /trips/:id/generate/:genId
 * Poll status for generation
 */
router.get('/:id/generate/:genId', auth, async (req, res) => {
  try {
    const genId = Number(req.params.genId);
    const userId = req.user.id;
    const rowRes = await pool.query('SELECT * FROM itinerary_generations WHERE id = $1 AND user_id = $2', [genId, userId]);
    if (!rowRes.rows.length) return res.status(404).json({ message: 'Not found' });
    return res.json(rowRes.rows[0]);
  } catch (err) {
    console.error('GET generation status error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
