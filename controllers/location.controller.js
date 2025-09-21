// controllers/location.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * Helper: normalize DB row to API shape
 * We map latitud -> latitude and longitud -> longitude
 */
function normalizeRow(row) {
  return {
    id: row.id,
    titulo: row.titulo,
    fk_interest: row.fk_interest,
    descripcion: row.descripcion,
    // alias DB latin names to english keys used on client
    latitude:
      row.latitude !== undefined
        ? Number(row.latitude)
        : row.latitud !== undefined
        ? Number(row.latitud)
        : null,
    longitude:
      row.longitude !== undefined
        ? Number(row.longitude)
        : row.longitud !== undefined
        ? Number(row.longitud)
        : null,
    imagenes: row.imagenes,
  };
}

/**
 * GET /locations/interests
 * Devuelve los fk_interest que hay en la tabla locations con su count.
 * Ejemplo de respuesta: [{ id: 'naturaleza', count: 12 }, { id: 'cultura', count: 7 }, ...]
 */
router.get('/interests', async (req, res) => {
  try {
    const sql = `
      SELECT fk_interest AS id, COUNT(*)::int AS count
      FROM locations
      WHERE fk_interest IS NOT NULL AND fk_interest <> ''
      GROUP BY fk_interest
      ORDER BY count DESC
    `;
    const result = await pool.query(sql);
    // normalizamos id como string y count como int
    const rows = result.rows.map((r) => ({ id: String(r.id), count: Number(r.count) }));
    return res.json(rows);
  } catch (err) {
    console.error('GET /locations/interests error:', err?.message || err);
    return res.status(500).json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * GET /locations
 * List locations (public). Supports optional query params:
 *  - interest (slug or id)
 *  - limit, offset (pagination)
 */
router.get('/', async (req, res) => {
  try {
    const { interest, limit = 50, offset = 0 } = req.query;

    if (interest) {
      // interest supplied (likely a slug like "naturaleza")
      // params: interest, limit, offset
      const sql = `
        SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes
        FROM locations
        WHERE fk_interest = $1
        ORDER BY id
        LIMIT $2 OFFSET $3
      `;
      const result = await pool.query(sql, [interest, limit, offset]);
      const rows = result.rows.map(normalizeRow);
      return res.json(rows);
    } else {
      // no interest filter
      const sql = `
        SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes
        FROM locations
        ORDER BY id
        LIMIT $1 OFFSET $2
      `;
      const result = await pool.query(sql, [limit, offset]);
      const rows = result.rows.map(normalizeRow);
      return res.json(rows);
    }
  } catch (err) {
    console.error('GET /locations error:', err?.message || err);
    // include error detail to help debugging locally (remove in production)
    return res.status(500).json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * GET /locations/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await pool.query(
      `SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes
       FROM locations WHERE id = $1`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'No encontrado' });
    return res.json(normalizeRow(result.rows[0]));
  } catch (err) {
    console.error('GET /locations/:id error:', err?.message || err);
    return res.status(500).json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * POST /locations
 * Create a location (protected)
 * Body: { titulo, fk_interest, descripcion, latitude, longitude, imagenes }
 * Note: client may send latitude/longitude; we store to latitud/longitud columns
 */
router.post('/', auth, async (req, res) => {
  try {
    const { titulo, fk_interest, descripcion, latitude, longitude, imagenes } = req.body;
    if (!titulo || !fk_interest) return res.status(400).json({ message: 'Faltan campos obligatorios' });

    const lat = latitude !== undefined ? latitude : req.body.latitud;
    const lng = longitude !== undefined ? longitude : req.body.longitud;

    const imagenesJson = imagenes ? (typeof imagenes === 'string' ? imagenes : JSON.stringify(imagenes)) : null;

    const result = await pool.query(
      `INSERT INTO locations (titulo, fk_interest, descripcion, latitud, longitud, imagenes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, titulo, fk_interest, descripcion, latitud, longitud, imagenes`,
      [titulo, fk_interest, descripcion || null, lat || null, lng || null, imagenesJson]
    );

    return res.status(201).json({ message: 'Localidad creada', location: normalizeRow(result.rows[0]) });
  } catch (err) {
    console.error('POST /locations error:', err?.message || err);
    return res.status(500).json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * PUT /locations/:id
 * Partial updates allowed. Accepts latitude/longitude or latitud/longitud in body.
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await pool.query('SELECT * FROM locations WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ message: 'No encontrado' });

    const {
      titulo = existing.rows[0].titulo,
      fk_interest = existing.rows[0].fk_interest,
      descripcion = existing.rows[0].descripcion,
      latitude,
      longitude,
      imagenes = existing.rows[0].imagenes,
    } = req.body;

    // prefer new latitude/longitude if provided, else keep existing latitud/longitud
    const lat = latitude !== undefined ? latitude : (existing.rows[0].latitud ?? existing.rows[0].latitude);
    const lng = longitude !== undefined ? longitude : (existing.rows[0].longitud ?? existing.rows[0].longitude);

    const imagenesJson = imagenes && typeof imagenes !== 'string' ? JSON.stringify(imagenes) : imagenes;

    const updated = await pool.query(
      `UPDATE locations
       SET titulo = $1, fk_interest = $2, descripcion = $3, latitud = $4, longitud = $5, imagenes = $6
       WHERE id = $7
       RETURNING id, titulo, fk_interest, descripcion, latitud, longitud, imagenes`,
      [titulo, fk_interest, descripcion || null, lat || null, lng || null, imagenesJson || null, id]
    );

    return res.json({ message: 'Localidad actualizada', location: normalizeRow(updated.rows[0]) });
  } catch (err) {
    console.error('PUT /locations/:id error:', err?.message || err);
    return res.status(500).json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * DELETE /locations/:id
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const del = await pool.query('DELETE FROM locations WHERE id = $1 RETURNING id', [id]);
    if (!del.rows.length) return res.status(404).json({ message: 'No encontrado' });
    return res.json({ message: 'Localidad eliminada' });
  } catch (err) {
    console.error('DELETE /locations/:id error:', err?.message || err);
    return res.status(500).json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

module.exports = router;
