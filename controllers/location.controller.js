// controllers/location.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * Helper: normalize DB row to API shape
 * We map latitud -> latitude and longitud -> longitude
 */
function normalizeRow(r) {
  return {
    id: r.id,
    title: r.titulo || null,
    interest: r.fk_interest || null,
    description: r.descripcion || null,
    latitude:
      r.latitud !== null && r.latitud !== undefined
        ? Number(r.latitud)
        : null,
    longitude:
      r.longitud !== null && r.longitud !== undefined
        ? Number(r.longitud)
        : null,
    images: r.imagenes || null,
    relevance:
      r.relevancia !== null && r.relevancia !== undefined
        ? Number(r.relevancia)
        : null,
    country: r.country || null,
    city: r.city || null,
    opening_hours: r.opening_hours || null,
    website: r.website || null,
    // nuevos campos de filtrado
    duration_tag: r.duration_tag || null,
    budget_tag: r.budget_tag || null,
    season_tag: r.season_tag || null,
  };
}

/**
 * GET /locations
 * List locations (public). Supports optional query params:
 *  - interest (slug or id)
 *  - country (string, optional)
 *  - duration (corto|medio|largo|fin_semana)
 *  - budget (economico|moderado|lujo)
 *  - season (primavera|verano|otono|invierno)
 *  - limit, offset (pagination)
 */
router.get('/', async (req, res) => {
  try {
    let {
      interest,
      country,
      duration,
      budget,
      season,
      limit = 50,
      offset = 0,
    } = req.query;

    // safe ints + max limit guard
    limit = Number.parseInt(limit, 10) || 50;
    offset = Number.parseInt(offset, 10) || 0;
    const MAX_LIMIT = 1000;
    if (limit < 1) limit = 1;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    if (offset < 0) offset = 0;

    // build WHERE clauses dynamically and parameterize
    const where = [];
    const params = [];

    if (interest) {
      // previous behaviour: compare fk_interest to provided interest
      params.push(interest);
      where.push(`fk_interest = $${params.length}`);
    }

    if (country) {
      // case-insensitive partial match; use ILIKE with %..%
      params.push(`%${country}%`);
      where.push(`country ILIKE $${params.length}`);
    }

    if (duration) {
      params.push(duration.toLowerCase());
      where.push(`LOWER(duration_tag) = $${params.length}`);
    }

    if (budget) {
      params.push(budget.toLowerCase());
      where.push(`LOWER(budget_tag) = $${params.length}`);
    }

    if (season) {
      params.push(season.toLowerCase());
      where.push(`LOWER(season_tag) = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT
        id,
        titulo,
        fk_interest,
        descripcion,
        latitud,
        longitud,
        imagenes,
        relevancia,
        country,
        city,
        opening_hours,
        website,
        duration_tag,
        budget_tag,
        season_tag
      FROM locations
      ${whereSql}
      ORDER BY relevancia DESC NULLS LAST, id
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    const result = await pool.query(sql, params);
    const rows = (result.rows || []).map(normalizeRow);

    return res.json(rows);
  } catch (err) {
    console.error('GET /locations error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * GET /locations/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await pool.query(
      `SELECT
         id,
         titulo,
         fk_interest,
         descripcion,
         latitud,
         longitud,
         imagenes,
         relevancia,
         country,
         city,
         opening_hours,
         website,
         duration_tag,
         budget_tag,
         season_tag
       FROM locations
       WHERE id = $1`,
      [id]
    );
    if (!result.rows.length)
      return res.status(404).json({ message: 'No encontrado' });
    return res.json(normalizeRow(result.rows[0]));
  } catch (err) {
    console.error('GET /locations/:id error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * POST /locations
 * Create a location (protected)
 * Body: {
 *   titulo, fk_interest, descripcion,
 *   latitude, longitude,
 *   imagenes, relevancia,
 *   country?, city?, opening_hours?, website?,
 *   duration_tag?, budget_tag?, season_tag?
 * }
 */
router.post('/', auth, async (req, res) => {
  try {
    const {
      titulo,
      fk_interest,
      descripcion,
      latitude,
      longitude,
      imagenes,
      relevancia,
      country,
      city,
      opening_hours,
      website,
      duration_tag,
      budget_tag,
      season_tag,
    } = req.body;

    if (!titulo || !fk_interest)
      return res
        .status(400)
        .json({ message: 'Faltan campos obligatorios' });

    const lat =
      latitude !== undefined ? latitude : req.body.latitud;
    const lng =
      longitude !== undefined ? longitude : req.body.longitud;

    const imagenesJson = imagenes
      ? typeof imagenes === 'string'
        ? imagenes
        : JSON.stringify(imagenes)
      : null;

    const result = await pool.query(
      `INSERT INTO locations (
         titulo,
         fk_interest,
         descripcion,
         latitud,
         longitud,
         imagenes,
         relevancia,
         country,
         city,
         opening_hours,
         website,
         duration_tag,
         budget_tag,
         season_tag
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING
         id,
         titulo,
         fk_interest,
         descripcion,
         latitud,
         longitud,
         imagenes,
         relevancia,
         country,
         city,
         opening_hours,
         website,
         duration_tag,
         budget_tag,
         season_tag`,
      [
        titulo,
        fk_interest,
        descripcion || null,
        lat || null,
        lng || null,
        imagenesJson,
        relevancia || null,
        country || null,
        city || null,
        opening_hours || null,
        website || null,
        duration_tag || null,
        budget_tag || null,
        season_tag || null,
      ]
    );

    return res.status(201).json({
      message: 'Localidad creada',
      location: normalizeRow(result.rows[0]),
    });
  } catch (err) {
    console.error('POST /locations error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * PUT /locations/:id
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existingRes = await pool.query(
      'SELECT * FROM locations WHERE id = $1',
      [id]
    );
    if (!existingRes.rows.length)
      return res.status(404).json({ message: 'No encontrado' });

    const existing = existingRes.rows[0];

    const {
      titulo = existing.titulo,
      fk_interest = existing.fk_interest,
      descripcion = existing.descripcion,
      latitude,
      longitude,
      imagenes = existing.imagenes,
      relevancia = existing.relevancia,
      country = existing.country,
      city = existing.city,
      opening_hours = existing.opening_hours,
      website = existing.website,
      duration_tag = existing.duration_tag,
      budget_tag = existing.budget_tag,
      season_tag = existing.season_tag,
    } = req.body;

    const lat =
      latitude !== undefined
        ? latitude
        : existing.latitud ?? existing.latitude;
    const lng =
      longitude !== undefined
        ? longitude
        : existing.longitud ?? existing.longitude;

    const imagenesJson =
      imagenes && typeof imagenes !== 'string'
        ? JSON.stringify(imagenes)
        : imagenes;

    const updated = await pool.query(
      `UPDATE locations
       SET
         titulo = $1,
         fk_interest = $2,
         descripcion = $3,
         latitud = $4,
         longitud = $5,
         imagenes = $6,
         relevancia = $7,
         country = $8,
         city = $9,
         opening_hours = $10,
         website = $11,
         duration_tag = $12,
         budget_tag = $13,
         season_tag = $14
       WHERE id = $15
       RETURNING
         id,
         titulo,
         fk_interest,
         descripcion,
         latitud,
         longitud,
         imagenes,
         relevancia,
         country,
         city,
         opening_hours,
         website,
         duration_tag,
         budget_tag,
         season_tag`,
      [
        titulo,
        fk_interest,
        descripcion || null,
        lat || null,
        lng || null,
        imagenesJson || null,
        relevancia || null,
        country || null,
        city || null,
        opening_hours || null,
        website || null,
        duration_tag || null,
        budget_tag || null,
        season_tag || null,
        id,
      ]
    );

    return res.json({
      message: 'Localidad actualizada',
      location: normalizeRow(updated.rows[0]),
    });
  } catch (err) {
    console.error('PUT /locations/:id error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * DELETE /locations/:id
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const del = await pool.query(
      'DELETE FROM locations WHERE id = $1 RETURNING id',
      [id]
    );
    if (!del.rows.length)
      return res.status(404).json({ message: 'No encontrado' });
    return res.json({ message: 'Localidad eliminada' });
  } catch (err) {
    console.error('DELETE /locations/:id error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

module.exports = router;
