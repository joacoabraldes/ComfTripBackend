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
    // try to return imagenes as array if it's a JSON/string column
    imagenes: (() => {
      const v = row.imagenes ?? row.images ?? null;
      if (!v) return [];
      if (Array.isArray(v)) return v;
      try {
        // if JSON string
        if (typeof v === 'string') {
          const t = v.trim();
          if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('"') && t.endsWith('"'))) {
            const parsed = JSON.parse(t);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === 'object') return [parsed];
          }
          // fallback: split by commas
          return t.replace(/^\[|\]$/g, '').replace(/(^"|"$)/g, '').split(',').map(s => s.trim()).filter(Boolean);
        }
      } catch (e) {
        try {
          // final fallback
          return String(v).replace(/^\[|\]$/g, '').replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean);
        } catch (_e) {
          return [];
        }
      }
      return [];
    })(),
    relevancia: row.relevancia !== undefined && row.relevancia !== null ? Number(row.relevancia) : 0,
    country: row.country ?? null,
  };
}

/**
 * GET /locations
 * List locations (public). Supports optional query params:
 *  - interest (slug or id)
 *  - country (case-insensitive match)
 *  - limit, offset (pagination)
 */
router.get('/', async (req, res) => {
  try {
    const { interest, country, limit = 50, offset = 0 } = req.query;

    // Build dynamic WHERE clause
    const where = [];
    const params = [];

    if (interest) {
      params.push(interest);
      where.push(`fk_interest = $${params.length}`);
    }

    if (country) {
      params.push(country);
      // ILIKE for case-insensitive match and allow partial matches
      where.push(`country ILIKE $${params.length}`);
    }

    let sql = `
      SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country
      FROM locations
    `;
    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    sql += ` ORDER BY relevancia DESC NULLS LAST, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    params.push(limit, offset);

    const result = await pool.query(sql, params);
    const rows = result.rows.map(normalizeRow);
    return res.json(rows);
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
      `SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country
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
 * Body: { titulo, fk_interest, descripcion, latitude, longitude, imagenes, relevancia, country }
 */
router.post('/', auth, async (req, res) => {
  try {
    const { titulo, fk_interest, descripcion, latitude, longitude, imagenes, relevancia, country } = req.body;
    if (!titulo || !fk_interest) return res.status(400).json({ message: 'Faltan campos obligatorios' });

    const lat = latitude !== undefined ? latitude : req.body.latitud;
    const lng = longitude !== undefined ? longitude : req.body.longitud;

    const imagenesJson = imagenes ? (typeof imagenes === 'string' ? imagenes : JSON.stringify(imagenes)) : null;

    const result = await pool.query(
      `INSERT INTO locations (titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country`,
      [titulo, fk_interest, descripcion || null, lat || null, lng || null, imagenesJson, relevancia || null, country || null]
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

    const {
      titulo = existing.rows[0].titulo,
      fk_interest = existing.rows[0].fk_interest,
      descripcion = existing.rows[0].descripcion,
      latitude,
      longitude,
      imagenes = existing.rows[0].imagenes,
      relevancia = existing.rows[0].relevancia,
      country = existing.rows[0].country
    } = req.body;

    const lat = latitude !== undefined ? latitude : (existing.rows[0].latitud ?? existing.rows[0].latitude);
    const lng = longitude !== undefined ? longitude : (existing.rows[0].longitud ?? existing.rows[0].longitude);

    const imagenesJson = imagenes && typeof imagenes !== 'string' ? JSON.stringify(imagenes) : imagenes;

    const updated = await pool.query(
      `UPDATE locations
       SET titulo = $1, fk_interest = $2, descripcion = $3, latitud = $4, longitud = $5, imagenes = $6, relevancia = $7, country = $8
       WHERE id = $9
       RETURNING id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country`,
      [titulo, fk_interest, descripcion || null, lat || null, lng || null, imagenesJson || null, relevancia || null, country || null, id]
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
