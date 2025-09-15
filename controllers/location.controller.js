// controllers/locations.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * GET /locations
 * List locations (public). Supports optional query params:
 *  - interest (slug or id)
 *  - limit, offset (pagination)
 */
router.get('/', async (req, res) => {
  try {
    const { interest, limit = 50, offset = 0 } = req.query;
    const params = [limit, offset];
    let sql = `SELECT id, titulo, fk_interest, descripcion, latitude, longitude, imagenes
               FROM locations
               ORDER BY id
               LIMIT $1 OFFSET $2`;

    if (interest) {
      // try matching by fk_interest value (slug or id)
      params.unshift(interest); // becomes $1
      // shift previous params' numbers by 1
      sql = `SELECT id, titulo, fk_interest, descripcion, latitude, longitude, imagenes
             FROM locations
             WHERE fk_interest = $1
             ORDER BY id
             LIMIT $2 OFFSET $3`;
    }

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /locations error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * GET /locations/:id
 * Get single location by id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await pool.query(
      `SELECT id, titulo, fk_interest, descripcion, latitude, longitude, imagenes
       FROM locations WHERE id = $1`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /locations/:id error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * POST /locations
 * Create a location (protected)
 * Body: { titulo, fk_interest, descripcion, latitude, longitude, imagenes }
 * imagenes can be an array (will be stored as JSON) or JSON object/string
 */
router.post('/', auth, async (req, res) => {
  try {
    const { titulo, fk_interest, descripcion, latitude, longitude, imagenes } = req.body;
    if (!titulo || !fk_interest) return res.status(400).json({ message: 'Faltan campos obligatorios' });

    const imagenesJson = imagenes ? (typeof imagenes === 'string' ? imagenes : JSON.stringify(imagenes)) : null;

    const result = await pool.query(
      `INSERT INTO locations (titulo, fk_interest, descripcion, latitude, longitude, imagenes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, titulo, fk_interest, descripcion, latitude, longitude, imagenes`,
      [titulo, fk_interest, descripcion || null, latitude || null, longitude || null, imagenesJson]
    );

    res.status(201).json({ message: 'Localidad creada', location: result.rows[0] });
  } catch (err) {
    console.error('POST /locations error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * PUT /locations/:id
 * Update an existing location (protected)
 * Body same as POST. Partial updates are allowed.
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // fetch existing to allow partial update
    const existing = await pool.query('SELECT * FROM locations WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ message: 'No encontrado' });

    const {
      titulo = existing.rows[0].titulo,
      fk_interest = existing.rows[0].fk_interest,
      descripcion = existing.rows[0].descripcion,
      latitude = existing.rows[0].latitude,
      longitude = existing.rows[0].longitude,
      imagenes = existing.rows[0].imagenes,
    } = req.body;

    const imagenesJson = imagenes && typeof imagenes !== 'string' ? JSON.stringify(imagenes) : imagenes;

    const updated = await pool.query(
      `UPDATE locations
       SET titulo = $1, fk_interest = $2, descripcion = $3, latitude = $4, longitude = $5, imagenes = $6
       WHERE id = $7
       RETURNING id, titulo, fk_interest, descripcion, latitude, longitude, imagenes`,
      [titulo, fk_interest, descripcion || null, latitude || null, longitude || null, imagenesJson || null, id]
    );

    res.json({ message: 'Localidad actualizada', location: updated.rows[0] });
  } catch (err) {
    console.error('PUT /locations/:id error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * DELETE /locations/:id
 * Delete location (protected)
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const del = await pool.query('DELETE FROM locations WHERE id = $1 RETURNING id', [id]);
    if (!del.rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json({ message: 'Localidad eliminada' });
  } catch (err) {
    console.error('DELETE /locations/:id error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;
