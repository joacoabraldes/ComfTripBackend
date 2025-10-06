// controllers/share.controller.js
'use strict';

const express = require('express');
const pool = require('../db');
const router = express.Router();

/**
 * GET /share/trip/:uuid
 * Public endpoint to retrieve a shared trip (viewer or editor depending on token).
 * If the share row is not public but has shared_with set, the caller must be authenticated
 * and match either the shared_with or be the owner (this route does not check auth automatically;
 * the consumer may call the authenticated /trips/:id endpoints if they have credentials).
 *
 * This implementation:
 *  - Finds the trip_share by uuid
 *  - Checks expiration
 *  - Returns trip + places in the same shape as GET /trips/:id (read-only)
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

    // load trip and places (owner may be different)
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

    // normalize similar to trip.controller.normalizeTripRow
    const trip = {
      id: row.id,
      user_id: row.user_id,
      destination: row.destination,
      start_date: row.start_date,
      end_date: row.end_date,
      budget: row.budget,
      notes: row.notes,
      created_at: row.created_at,
      places: row.places || []
    };

    // Add some metadata about the share (mode, public, expires_at)
    res.json({
      share: {
        mode: share.mode,
        public: share.public,
        shared_by: share.shared_by,
        shared_with: share.shared_with,
        expires_at: share.expires_at,
        created_at: share.created_at
      },
      trip
    });
  } catch (err) {
    console.error('GET /share/trip/:uuid error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;
