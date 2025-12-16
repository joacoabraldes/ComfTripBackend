// controllers/share.controller.js
'use strict';

const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

/**
 * GET /share/trip/:uuid
 */
router.get('/trip/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;

    const shareRow = await pool.query('SELECT * FROM trip_shares WHERE share_uuid = $1 LIMIT 1', [uuid]);
    if (!shareRow.rows.length) return res.status(404).json({ message: 'Share no encontrado' });
    const share = shareRow.rows[0];

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ message: 'El enlace ha expirado' });
    }

    const PLACES_AGG_SUBQUERY = `
      SELECT fk_trips,
             json_agg(json_build_object(
               'id', tp.id,
               'fk_location', tp.fk_locations,
               'date', tp.date,
               'start_hour', tp.start_hour,
               'end_hour', tp.end_hour,
               'notes', tp.notes,
               'location', json_build_object(
                 'id', l.id,
                 'titulo', l.titulo,
                 'fk_interest', l.fk_interest,
                 'latitude', l.latitud,
                 'longitude', l.longitud,
                 'imagenes', l.imagenes,
                 'relevancia', l.relevancia
               )
             ) ORDER BY tp.date, tp.start_hour) AS places
      FROM trip_places tp
      JOIN locations l ON l.id = tp.fk_locations
      GROUP BY fk_trips
    `;

    const sql = `
      SELECT
        t.id, t.user_id, t.destination, t.start_date, t.end_date, t.budget, t.notes, t.created_at,
        COALESCE(tp.places, '[]') AS places
      FROM trips t
      LEFT JOIN (
        ${PLACES_AGG_SUBQUERY}
      ) tp ON tp.fk_trips = t.id
      WHERE t.id = $1
      LIMIT 1
    `;

    const tripRes = await pool.query(sql, [share.trip_id]);
    if (!tripRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    const row = tripRes.rows[0];

    const trip = {
      id: row.id,
      user_id: row.user_id,
      destination: row.destination,
      start_date: row.start_date,
      end_date: row.end_date,
      budget: row.budget,
      notes: row.notes,
      created_at: row.created_at,
      places: row.places || [],
    };

    res.json({
      share: {
        mode: share.mode,
        public: share.public,
        shared_by: share.shared_by,
        shared_with: share.shared_with,
        expires_at: share.expires_at,
        created_at: share.created_at,
      },
      trip,
    });
  } catch (err) {
    console.error('GET /share/trip/:uuid error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

//GET /share/by-me/:friendId
router.get('/by-me/:friendId', auth, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const friendId = Number(req.params.friendId);

    const result = await pool.query(
      `
      SELECT
        t.id,
        t.destination,
        t.start_date,
        t.end_date,
        ts.mode,
        ts.created_at
      FROM trip_shares ts
      JOIN trips t ON t.id = ts.trip_id
      WHERE ts.shared_by = $1
        AND ts.shared_with = $2
        AND (ts.expires_at IS NULL OR ts.expires_at > now())
      ORDER BY t.start_date DESC
    `,
      [ownerId, friendId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

// GET /share/trip/:tripId/users
router.get('/trip/:tripId/users', auth, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const { tripId } = req.params;

    const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [tripId, ownerId]);
    if (!tripRes.rows.length) return res.status(403).json({ message: 'No sos el dueño del viaje' });

    const result = await pool.query(
      `
      SELECT u.id, u.name, u.username, u.email, ts.mode
      FROM trip_shares ts
      JOIN users u ON u.id = ts.shared_with
      WHERE ts.trip_id = $1
        AND (ts.expires_at IS NULL OR ts.expires_at > now())
      ORDER BY ts.created_at DESC
      `,
      [tripId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('GET /share/trip/:tripId/users error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

// DELETE /share/trip/:uuid/leave
router.delete('/trip/:uuid/leave', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { uuid } = req.params;

    const shareRes = await pool.query(`SELECT * FROM trip_shares WHERE share_uuid = $1 LIMIT 1`, [uuid]);
    if (!shareRes.rows.length) return res.status(404).json({ message: 'Share no encontrado' });

    const share = shareRes.rows[0];
    if (share.shared_with !== userId) return res.status(403).json({ message: 'No tenés permiso' });

    await pool.query(`DELETE FROM trip_shares WHERE id = $1`, [share.id]);
    res.json({ message: 'Acceso eliminado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

router.delete('/trip/:tripId/user/:userId', auth, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const { tripId, userId } = req.params;

    const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [tripId, ownerId]);
    if (!tripRes.rows.length) return res.status(403).json({ message: 'No sos el dueño del viaje' });

    const r = await pool.query(`DELETE FROM trip_shares WHERE trip_id = $1 AND shared_with = $2`, [tripId, userId]);
    res.json({ message: 'Acceso eliminado', deleted: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;
