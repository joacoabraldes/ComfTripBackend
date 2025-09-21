// controllers/interest.controller.js
const express = require('express');
const pool = require('../db');
const router = express.Router();

/**
 * GET /interests
 * Devuelve todas las categorías (tabla interests) y el count de locations por slug.
 * Ejemplo de salida:
 * [ { id: 1, slug: 'cultura', title: 'Cultura y entretenimiento', description: '...', count: 98 }, ... ]
 */
router.get('/', async (req, res) => {
  try {
    const sql = `
      SELECT i.id, i.slug, i.title, i.description,
             COALESCE(l.cnt,0) AS count
      FROM interests i
      LEFT JOIN (
        SELECT fk_interest, COUNT(*)::int AS cnt
        FROM locations
        WHERE fk_interest IS NOT NULL AND fk_interest <> ''
        GROUP BY fk_interest
      ) l ON l.fk_interest = i.slug
      ORDER BY i.id
    `;
    const result = await pool.query(sql);
    const rows = result.rows.map(r => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      description: r.description,
      count: Number(r.count || 0)
    }));
    return res.json(rows);
  } catch (err) {
    console.error('GET /interests error:', err?.message || err);
    return res.status(500).json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

module.exports = router;
