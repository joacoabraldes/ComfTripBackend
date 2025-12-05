// controllers/social.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const router = express.Router();

/**
 * Directorio base de uploads
 * Usamos OS tmpdir para que funcione en Vercel / serverless (/tmp)
 * y localmente también.
 */
const UPLOAD_ROOT =
  process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'comftrip_uploads');

// Carpeta específica para fotos del social feed
const uploadDir = path.join(UPLOAD_ROOT, 'social');

// Nos aseguramos de que exista
fs.mkdirSync(uploadDir, { recursive: true });

/**
 * Configuración de multer para subir imágenes
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path.basename(file.originalname || 'image', ext);
    const safeBase = base.replace(/[^a-zA-Z0-9_-]/g, '');
    const ts = Date.now();
    cb(null, `${safeBase || 'photo'}_${ts}${ext || '.jpg'}`);
  },
});

function imageFileFilter(req, file, cb) {
  if (!file.mimetype || !file.mimetype.startsWith('image/')) {
    return cb(new Error('Solo se permiten archivos de imagen'), false);
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

/**
 * Helper para obtener el userId del token
 */
function getUserIdFromReq(req) {
  return req.user?.id || req.user?.userId;
}

/**
 * Normaliza un post
 */
function normalizePostRow(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    author_name: r.author_name || null,
    author_username: r.author_username || null,
    trip_id: r.trip_id,
    location_id: r.location_id,
    content: r.content || '',
    images: r.images || null, // array o null (jsonb en PG)
    created_at: r.created_at,
    like_count:
      r.like_count !== null && r.like_count !== undefined
        ? Number(r.like_count)
        : 0,
    comment_count:
      r.comment_count !== null && r.comment_count !== undefined
        ? Number(r.comment_count)
        : 0,
    liked_by_me: r.liked_by_me === true || r.liked_by_me === 't',
  };
}

/**
 * GET /social/feed
 * Feed del usuario autenticado + sus amigos (friend_requests con status 'accepted')
 * Query params: limit, offset
 */
router.get('/feed', auth, async (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  try {
    let { limit = 20, offset = 0 } = req.query;
    limit = parseInt(limit, 10) || 20;
    offset = parseInt(offset, 10) || 0;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    if (offset < 0) offset = 0;

    const sql = `
      WITH friends AS (
        SELECT
          CASE
            WHEN fr.requester_id = $1 THEN fr.addressee_id
            ELSE fr.requester_id
          END AS friend_id
        FROM friend_requests fr
        WHERE fr.status = 'accepted'
          AND (fr.requester_id = $1 OR fr.addressee_id = $1)
      ),
      like_counts AS (
        SELECT post_id, COUNT(*)::int AS like_count
        FROM social_post_likes
        GROUP BY post_id
      ),
      comment_counts AS (
        SELECT post_id, COUNT(*)::int AS comment_count
        FROM social_post_comments
        GROUP BY post_id
      )
      SELECT
        sp.id,
        sp.user_id,
        u.name AS author_name,
        u.username AS author_username,
        sp.trip_id,
        sp.location_id,
        sp.content,
        sp.images,
        sp.created_at,
        COALESCE(lc.like_count, 0) AS like_count,
        COALESCE(cc.comment_count, 0) AS comment_count,
        EXISTS (
          SELECT 1
          FROM social_post_likes l
          WHERE l.post_id = sp.id
            AND l.user_id = $1
        ) AS liked_by_me
      FROM social_posts sp
      JOIN users u ON u.id = sp.user_id
      LEFT JOIN like_counts lc ON lc.post_id = sp.id
      LEFT JOIN comment_counts cc ON cc.post_id = sp.id
      WHERE
        sp.user_id = $1
        OR sp.user_id IN (SELECT friend_id FROM friends)
      ORDER BY sp.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(sql, [userId, limit, offset]);
    const posts = result.rows.map(normalizePostRow);
    return res.json(posts);
  } catch (err) {
    console.error('GET /social/feed error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * GET /social/posts
 * Lista de posts (opcionalmente por user_id)
 */
router.get('/posts', auth, async (req, res) => {
  try {
    let { user_id, limit = 20, offset = 0 } = req.query;
    limit = parseInt(limit, 10) || 20;
    offset = parseInt(offset, 10) || 0;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    if (offset < 0) offset = 0;

    const params = [];
    const where = [];

    if (user_id) {
      params.push(parseInt(user_id, 10));
      where.push(`sp.user_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      WITH like_counts AS (
        SELECT post_id, COUNT(*)::int AS like_count
        FROM social_post_likes
        GROUP BY post_id
      ),
      comment_counts AS (
        SELECT post_id, COUNT(*)::int AS comment_count
        FROM social_post_comments
        GROUP BY post_id
      )
      SELECT
        sp.id,
        sp.user_id,
        u.name AS author_name,
        u.username AS author_username,
        sp.trip_id,
        sp.location_id,
        sp.content,
        sp.images,
        sp.created_at,
        COALESCE(lc.like_count, 0) AS like_count,
        COALESCE(cc.comment_count, 0) AS comment_count,
        false AS liked_by_me
      FROM social_posts sp
      JOIN users u ON u.id = sp.user_id
      LEFT JOIN like_counts lc ON lc.post_id = sp.id
      LEFT JOIN comment_counts cc ON cc.post_id = sp.id
      ${whereSql}
      ORDER BY sp.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    const result = await pool.query(sql, params);
    const posts = result.rows.map(normalizePostRow);

    return res.json(posts);
  } catch (err) {
    console.error('GET /social/posts error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * GET /social/posts/:id
 * Detalle de un post (con contadores)
 */
router.get('/posts/:id', auth, async (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  try {
    const postId = parseInt(req.params.id, 10);

    const sql = `
      WITH like_counts AS (
        SELECT post_id, COUNT(*)::int AS like_count
        FROM social_post_likes
        GROUP BY post_id
      ),
      comment_counts AS (
        SELECT post_id, COUNT(*)::int AS comment_count
        FROM social_post_comments
        GROUP BY post_id
      )
      SELECT
        sp.id,
        sp.user_id,
        u.name AS author_name,
        u.username AS author_username,
        sp.trip_id,
        sp.location_id,
        sp.content,
        sp.images,
        sp.created_at,
        COALESCE(lc.like_count, 0) AS like_count,
        COALESCE(cc.comment_count, 0) AS comment_count,
        EXISTS (
          SELECT 1
          FROM social_post_likes l
          WHERE l.post_id = sp.id
            AND l.user_id = $2
        ) AS liked_by_me
      FROM social_posts sp
      JOIN users u ON u.id = sp.user_id
      LEFT JOIN like_counts lc ON lc.post_id = sp.id
      LEFT JOIN comment_counts cc ON cc.post_id = sp.id
      WHERE sp.id = $1
      LIMIT 1
    `;

    const result = await pool.query(sql, [postId, userId]);

    if (!result.rows.length) {
      return res.status(404).json({ message: 'Post no encontrado' });
    }

    return res.json(normalizePostRow(result.rows[0]));
  } catch (err) {
    console.error('GET /social/posts/:id error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * POST /social/posts
 * Crea un post nuevo
 * Soporta:
 *  - JSON: { content }
 *  - multipart/form-data: fields content, image (archivo)
 */
/**
 * POST /social/posts
 * Crea un post nuevo
 * Soporta:
 *  - Solo texto
 *  - Solo imagen
 *  - Texto + imagen
 *  - JSON (sin imagen) o multipart/form-data (con imagen)
 */
router.post(
  '/posts',
  auth,
  upload.single('image'), // campo "image" para la foto
  async (req, res) => {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ message: 'No autenticado' });
    }

    try {
      const { trip_id, location_id } = req.body;
      const rawContent = typeof req.body.content === 'string' ? req.body.content : '';
      const content = rawContent.trim();

      const hasText = content.length > 0;
      const hasImage = !!req.file;

      // ahora lo único prohibido es "nada de nada"
      if (!hasText && !hasImage) {
        return res
          .status(400)
          .json({ message: 'Debés enviar al menos texto o una imagen' });
      }

      // Armamos array de URLs de imágenes (si hay)
      let imageUrls = [];
      if (hasImage) {
        imageUrls.push(`/uploads/social/${req.file.filename}`);
      }
      const imagesJson = imageUrls.length ? JSON.stringify(imageUrls) : null;

      const result = await pool.query(
        `
        INSERT INTO social_posts (user_id, trip_id, location_id, content, images)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, user_id, trip_id, location_id, content, images, created_at
        `,
        [
          userId,
          trip_id || null,
          location_id || null,
          hasText ? content : null,
          imagesJson,
        ]
      );

      const post = result.rows[0];

      // Traemos username y name del autor
      const userRes = await pool.query(
        'SELECT username, name FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );
      const userRow = userRes.rows[0] || {};

      return res.status(201).json({
        message: 'Post creado',
        post: {
          id: post.id,
          user_id: post.user_id,
          trip_id: post.trip_id,
          location_id: post.location_id,
          content: post.content || '',
          images: post.images ? JSON.parse(post.images) : null,
          created_at: post.created_at,
          like_count: 0,
          comment_count: 0,
          liked_by_me: false,
          author_username: userRow.username || null,
          author_name: userRow.name || null,
        },
      });
    } catch (err) {
      console.error('POST /social/posts error:', err?.message || err);
      return res
        .status(500)
        .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
    }
  }
);


/**
 * DELETE /social/posts/:id
 * Solo el autor puede borrar
 */
router.delete('/posts/:id', auth, async (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  try {
    const postId = parseInt(req.params.id, 10);

    const existing = await pool.query(
      `SELECT user_id FROM social_posts WHERE id = $1`,
      [postId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ message: 'Post no encontrado' });
    }

    if (existing.rows[0].user_id !== userId) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    await pool.query(`DELETE FROM social_posts WHERE id = $1`, [postId]);

    return res.json({ message: 'Post eliminado' });
  } catch (err) {
    console.error('DELETE /social/posts/:id error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * POST /social/posts/:id/like
 * Toggle like/unlike para el usuario actual
 */
router.post('/posts/:id/like', auth, async (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  try {
    const postId = parseInt(req.params.id, 10);

    const existing = await pool.query(
      `SELECT id FROM social_posts WHERE id = $1`,
      [postId]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ message: 'Post no encontrado' });
    }

    const like = await pool.query(
      `SELECT id FROM social_post_likes WHERE post_id = $1 AND user_id = $2`,
      [postId, userId]
    );

    if (like.rows.length) {
      // ya existe -> unlike
      await pool.query(
        `DELETE FROM social_post_likes WHERE post_id = $1 AND user_id = $2`,
        [postId, userId]
      );
      return res.json({ liked: false });
    } else {
      // no existe -> like
      await pool.query(
        `INSERT INTO social_post_likes (post_id, user_id) VALUES ($1, $2)`,
        [postId, userId]
      );
      return res.json({ liked: true });
    }
  } catch (err) {
    console.error('POST /social/posts/:id/like error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * GET /social/posts/:id/comments
 * Lista comentarios de un post
 */
router.get('/posts/:id/comments', auth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);

    const sql = `
      SELECT
        c.id,
        c.post_id,
        c.user_id,
        u.name AS author_name,
        u.username AS author_username,
        c.content,
        c.created_at
      FROM social_post_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC
    `;

    const result = await pool.query(sql, [postId]);

    const comments = result.rows.map((r) => ({
      id: r.id,
      post_id: r.post_id,
      user_id: r.user_id,
      author_name: r.author_name,
      author_username: r.author_username,
      content: r.content,
      created_at: r.created_at,
    }));

    return res.json(comments);
  } catch (err) {
    console.error('GET /social/posts/:id/comments error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

/**
 * POST /social/posts/:id/comments
 * Crea un comentario
 * Body: { content }
 */
router.post('/posts/:id/comments', auth, async (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  try {
    const postId = parseInt(req.params.id, 10);
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ message: 'content es obligatorio' });
    }

    const post = await pool.query(
      `SELECT id FROM social_posts WHERE id = $1`,
      [postId]
    );
    if (!post.rows.length) {
      return res.status(404).json({ message: 'Post no encontrado' });
    }

    const result = await pool.query(
      `
      INSERT INTO social_post_comments (post_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, post_id, user_id, content, created_at
      `,
      [postId, userId, content]
    );

    const c = result.rows[0];

    return res.status(201).json({
      message: 'Comentario creado',
      comment: {
        id: c.id,
        post_id: c.post_id,
        user_id: c.user_id,
        content: c.content,
        created_at: c.created_at,
      },
    });
  } catch (err) {
    console.error('POST /social/posts/:id/comments error:', err?.message || err);
    return res
      .status(500)
      .json({ message: 'Error en el servidor', detail: err?.message || String(err) });
  }
});

module.exports = router;
