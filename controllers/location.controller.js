// controllers/location.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * Helper: normalize DB row to API shape
 * We map latitud -> latitude and longitud -> longitude
 * Parse imagenes and opening_hours if stored as strings
 */
function safeParseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (e) {
    return value;
  }
}

function normalizeRow(row) {
  const imagenes = safeParseJson(row.imagenes) || [];
  const opening_hours = safeParseJson(row.opening_hours) || null;

  const latitude =
    row.latitude !== undefined
      ? Number(row.latitude)
      : row.latitud !== undefined
      ? Number(row.latitud)
      : null;

  const longitude =
    row.longitude !== undefined
      ? Number(row.longitude)
      : row.longitud !== undefined
      ? Number(row.longitud)
      : null;

  return {
    id: row.id,
    titulo: row.titulo,
    fk_interest: row.fk_interest,
    descripcion: row.descripcion,
    // alias DB latin names to english keys used on client
    latitude,
    longitude,
    imagenes: Array.isArray(imagenes) ? imagenes : [imagenes].filter(Boolean),
    relevancia: row.relevancia !== undefined && row.relevancia !== null ? Number(row.relevancia) : 0,
    opening_hours,
    website: row.website || null,
    category: row.category || null,
    city: row.city || null,
    country: row.country || null,
    created_at: row.created_at || null
  };
}

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
      const sql = `
        SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia,
               opening_hours, website, category, city, country, created_at
        FROM locations
        WHERE fk_interest = $1
        ORDER BY relevancia DESC NULLS LAST, id
        LIMIT $2 OFFSET $3
      `;
      const result = await pool.query(sql, [interest, limit, offset]);
      const rows = result.rows.map(normalizeRow);
      return res.json(rows);
    } else {
      const sql = `
        SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia,
               opening_hours, website, category, city, country, created_at
        FROM locations
        ORDER BY relevancia DESC NULLS LAST, id
        LIMIT $1 OFFSET $2
      `;
      const result = await pool.query(sql, [limit, offset]);
      const rows = result.rows.map(normalizeRow);
      return res.json(rows);
    }
  } catch (err) {
    console.error('GET /locations error:', err?.message || err);
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
      `SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia,
              opening_hours, website, category, city, country, created_at
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
 * Body: { titulo, fk_interest, descripcion, latitude, longitude, latitud, longitud, imagenes, relevancia, opening_hours, website, category, city, country }
 */
router.post('/', auth, async (req, res) => {
  try {
    const {
      titulo,
      fk_interest,
      descripcion,
      latitude,
      longitude,
      latitud,
      longitud,
      imagenes,
      relevancia,
      opening_hours,
      website,
      category,
      city,
      country
    } = req.body;
    if (!titulo || !fk_interest) return res.status(400).json({ message: 'Faltan campos obligatorios' });

    const lat = latitude !== undefined ? latitude : latitud;
    const lng = longitude !== undefined ? longitude : longitud;

    const imagenesJson = imagenes ? (typeof imagenes === 'string' ? imagenes : JSON.stringify(imagenes)) : null;
    const openingHoursJson = opening_hours ? (typeof opening_hours === 'string' ? opening_hours : JSON.stringify(opening_hours)) : null;

    const result = await pool.query(
      `INSERT INTO locations (titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, opening_hours, website, category, city, country)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, opening_hours, website, category, city, country, created_at`,
      [titulo, fk_interest, descripcion || null, lat || null, lng || null, imagenesJson, relevancia || null, openingHoursJson, website || null, category || null, city || null, country || null]
    );

    return res.status(201).json({ message: 'Localidad creada', location: normalizeRow(result.rows[0]) });
  } catch (err) {
    console.error('POST /locations error:', err?.message || err);
    return res.status(500).json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * PUT /locations/:id
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await pool.query('SELECT * FROM locations WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ message: 'No encontrado' });

    const ex = existing.rows[0];

    const {
      titulo = ex.titulo,
      fk_interest = ex.fk_interest,
      descripcion = ex.descripcion,
      latitude,
      longitude,
      latitud,
      longitud,
      imagenes = ex.imagenes,
      relevancia = ex.relevancia,
      opening_hours = ex.opening_hours,
      website = ex.website,
      category = ex.category,
      city = ex.city,
      country = ex.country
    } = req.body;

    const lat = latitude !== undefined ? latitude : (latitud !== undefined ? latitud : (ex.latitud ?? ex.latitude));
    const lng = longitude !== undefined ? longitude : (longitud !== undefined ? longitud : (ex.longitud ?? ex.longitude));

    const imagenesJson = imagenes && typeof imagenes !== 'string' ? JSON.stringify(imagenes) : imagenes;
    const openingHoursJson = opening_hours && typeof opening_hours !== 'string' ? JSON.stringify(opening_hours) : opening_hours;

    const updated = await pool.query(
      `UPDATE locations
       SET titulo = $1, fk_interest = $2, descripcion = $3, latitud = $4, longitud = $5, imagenes = $6, relevancia = $7,
           opening_hours = $8, website = $9, category = $10, city = $11, country = $12
       WHERE id = $13
       RETURNING id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, opening_hours, website, category, city, country, created_at`,
      [titulo, fk_interest, descripcion || null, lat || null, lng || null, imagenesJson || null, relevancia || null, openingHoursJson || null, website || null, category || null, city || null, country || null, id]
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
