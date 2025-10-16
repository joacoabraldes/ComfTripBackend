'use strict';

const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

/**
 * POST /flights
 * Body: { flight_id: string (required), trip_id: number (optional) }
 * Creates a flight record owned by the authenticated user.
 */
router.post('/', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const { flight_id, trip_id } = req.body || {};

    if (!flight_id || String(flight_id).trim() === '') {
      return res.status(400).json({ message: 'flight_id es requerido' });
    }

    // ensure not already exists
    const exists = await client.query('SELECT flight_id FROM flights WHERE flight_id = $1 LIMIT 1', [String(flight_id)]);
    if (exists.rows.length) {
      return res.status(409).json({ message: 'flight_id ya existe' });
    }

    await client.query('BEGIN');
    const insertSQL = 'INSERT INTO flights (flight_id, user_id, trip_id, created_at) VALUES ($1,$2,$3, now()) RETURNING flight_id, user_id, trip_id, created_at';
    const values = [String(flight_id), userId, (Number.isFinite(Number(trip_id)) ? Number(trip_id) : null)];
    const r = await client.query(insertSQL, values);
    await client.query('COMMIT');

    return res.status(201).json({ flight: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /flights error:', err);
    return res.status(500).json({ message: 'Error creando vuelo' });
  } finally {
    client.release();
  }
});

/**
 * PUT /flights/:flight_id
 * Body: { trip_id: number (optional) }
 * Updates the trip association for a flight. Only the owner (flights.user_id) can update.
 */
router.put('/:flight_id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const flightId = String(req.params.flight_id || '').trim();
    const { trip_id } = req.body || {};

    if (!flightId) return res.status(400).json({ message: 'flight_id inválido' });

    // fetch existing
    const cur = await client.query('SELECT flight_id, user_id, trip_id FROM flights WHERE flight_id = $1 LIMIT 1', [flightId]);
    if (!cur.rows.length) return res.status(404).json({ message: 'Vuelo no encontrado' });
    const row = cur.rows[0];
    if (row.user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    // perform update (only trip_id can be changed here)
    const newTripId = (typeof trip_id !== 'undefined' && Number.isFinite(Number(trip_id))) ? Number(trip_id) : null;

    const upd = await client.query('UPDATE flights SET trip_id = $1 WHERE flight_id = $2 RETURNING flight_id, user_id, trip_id, created_at', [newTripId, flightId]);
    return res.json({ flight: upd.rows[0] });
  } catch (err) {
    console.error('PUT /flights/:flight_id error:', err);
    res.status(500).json({ message: 'Error actualizando vuelo' });
  } finally {
    client.release();
  }
});

module.exports = router;
