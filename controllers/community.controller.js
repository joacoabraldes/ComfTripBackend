// controllers/community.controller.js
'use strict';

const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

/**
 * POST /
 * Send a friend request.
 * Body: { email } OR { username } (keeps { addressee_id } for backward compatibility)
 */
router.post('/', auth, async (req, res) => {
  try {
    const requesterId = req.user.id;
    const { addressee_id, email, username } = req.body;

    let addresseeId = addressee_id || null;

    if (!addresseeId && email) {
      const u = await pool.query(
        'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
        [email]
      );
      if (!u.rows.length) return res.status(404).json({ message: 'Usuario no encontrado por email' });
      addresseeId = u.rows[0].id;
    }

    if (!addresseeId && username) {
      const u = await pool.query(
        'SELECT id FROM users WHERE lower(username) = lower($1) LIMIT 1',
        [username]
      );
      if (!u.rows.length) return res.status(404).json({ message: 'Usuario no encontrado por username' });
      addresseeId = u.rows[0].id;
    }

    if (!addresseeId) return res.status(400).json({ message: 'email o username requerido' });
    if (Number(addresseeId) === requesterId) return res.status(400).json({ message: 'No puedes agregarte a ti mismo' });

    const existing = await pool.query(
      `SELECT id, status, requester_id, addressee_id
       FROM friend_requests
       WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)
       LIMIT 1`,
      [requesterId, addresseeId]
    );

    if (existing.rows.length) {
      const ex = existing.rows[0];
      if (ex.status === 'accepted') {
        return res.status(400).json({ message: 'Ya son amigos', request: ex });
      }
      if (ex.status === 'pending') {
        if (ex.requester_id === addresseeId && ex.addressee_id === requesterId) {
          await pool.query('UPDATE friend_requests SET status=$1 WHERE id=$2', ['accepted', ex.id]);
          return res.status(200).json({
            message: 'Solicitud aceptada automáticamente (tenías una solicitud entrante)',
            request: { id: ex.id, requester_id: ex.requester_id, addressee_id: ex.addressee_id, status: 'accepted' },
          });
        }
        return res.status(400).json({ message: 'Ya existe una solicitud pendiente', request: ex });
      }
    }

    const ins = await pool.query(
      'INSERT INTO friend_requests (requester_id, addressee_id, status) VALUES ($1,$2,$3) RETURNING id, requester_id, addressee_id, status, created_at',
      [requesterId, addresseeId, 'pending']
    );

    res.status(201).json({ request: ins.rows[0] });
  } catch (err) {
    console.error('POST / (send friend) error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * GET /requests
 */
router.get('/requests', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const incoming = await pool.query(
      `SELECT fr.id, fr.requester_id, u.name as requester_name, u.username as requester_username, u.email as requester_email, fr.created_at
       FROM friend_requests fr
       JOIN users u ON u.id = fr.requester_id
       WHERE fr.addressee_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [userId]
    );
    const outgoing = await pool.query(
      `SELECT fr.id, fr.addressee_id, u.name as addressee_name, u.username as addressee_username, u.email as addressee_email, fr.status, fr.created_at
       FROM friend_requests fr
       JOIN users u ON u.id = fr.addressee_id
       WHERE fr.requester_id = $1
       ORDER BY fr.created_at DESC`,
      [userId]
    );
    res.json({ incoming: incoming.rows, outgoing: outgoing.rows });
  } catch (err) {
    console.error('GET /requests error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

router.post('/accept', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const providedId = req.body.id || req.query.id || null;
    let reqId = null;

    if (providedId) {
      reqId = Number(providedId);
      if (!Number.isFinite(reqId)) return res.status(400).json({ message: 'Invalid request id' });
    } else {
      const r = await pool.query(
        'SELECT id FROM friend_requests WHERE addressee_id = $1 AND status = $2 ORDER BY created_at ASC LIMIT 1',
        [userId, 'pending']
      );
      if (!r.rows.length) return res.status(404).json({ message: 'No pending incoming requests' });
      reqId = r.rows[0].id;
    }

    const r = await client.query('SELECT * FROM friend_requests WHERE id = $1 LIMIT 1', [reqId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Solicitud no encontrada' });
    const fr = r.rows[0];
    if (fr.addressee_id !== userId) return res.status(403).json({ message: 'No autorizado' });
    if (fr.status === 'accepted') return res.status(400).json({ message: 'Ya aceptada' });

    await client.query('BEGIN');
    await client.query('UPDATE friend_requests SET status=$1 WHERE id=$2', ['accepted', reqId]);
    await client.query('COMMIT');

    res.json({ message: 'Solicitud aceptada', id: reqId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /accept error:', err);
    res.status(500).json({ message: 'Error' });
  } finally {
    client.release();
  }
});

router.post('/:id/accept', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const reqId = Number(req.params.id);
    const r = await pool.query('SELECT * FROM friend_requests WHERE id = $1 LIMIT 1', [reqId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Solicitud no encontrada' });
    const fr = r.rows[0];
    if (fr.addressee_id !== userId) return res.status(403).json({ message: 'No autorizado' });
    if (fr.status === 'accepted') return res.status(400).json({ message: 'Ya aceptada' });

    await pool.query('UPDATE friend_requests SET status=$1 WHERE id=$2', ['accepted', reqId]);
    res.json({ message: 'Solicitud aceptada' });
  } catch (err) {
    console.error('POST /:id/accept error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

router.post('/reject', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const providedId = req.body.id || req.query.id || null;
    let reqId = null;

    if (providedId) {
      reqId = Number(providedId);
      if (!Number.isFinite(reqId)) return res.status(400).json({ message: 'Invalid request id' });
    } else {
      const r = await pool.query(
        'SELECT id FROM friend_requests WHERE addressee_id = $1 AND status = $2 ORDER BY created_at ASC LIMIT 1',
        [userId, 'pending']
      );
      if (!r.rows.length) return res.status(404).json({ message: 'No pending incoming requests' });
      reqId = r.rows[0].id;
    }

    const r = await client.query('SELECT * FROM friend_requests WHERE id = $1 LIMIT 1', [reqId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Solicitud no encontrada' });
    const fr = r.rows[0];
    if (fr.addressee_id !== userId) return res.status(403).json({ message: 'No autorizado' });
    if (fr.status === 'rejected') return res.status(400).json({ message: 'Ya rechazada' });

    await client.query('BEGIN');
    await client.query('UPDATE friend_requests SET status=$1 WHERE id=$2', ['rejected', reqId]);
    await client.query('COMMIT');

    res.json({ message: 'Solicitud rechazada', id: reqId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /reject error:', err);
    res.status(500).json({ message: 'Error' });
  } finally {
    client.release();
  }
});

router.post('/:id/reject', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const reqId = Number(req.params.id);
    const r = await pool.query('SELECT * FROM friend_requests WHERE id = $1 LIMIT 1', [reqId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Solicitud no encontrada' });
    const fr = r.rows[0];
    if (fr.addressee_id !== userId) return res.status(403).json({ message: 'No autorizado' });
    if (fr.status === 'rejected') return res.status(400).json({ message: 'Ya rechazada' });

    await pool.query('UPDATE friend_requests SET status=$1 WHERE id=$2', ['rejected', reqId]);
    res.json({ message: 'Solicitud rechazada' });
  } catch (err) {
    console.error('POST /:id/reject error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * DELETE /:userId
 * Remove friendship AND revoke shares between both.
 */
router.delete('/:userId', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const otherId = Number(req.params.userId);

    await client.query('BEGIN');

    const r = await client.query(
      `SELECT id
       FROM friend_requests
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1)
       LIMIT 1`,
      [userId, otherId]
    );

    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Relación no encontrada' });
    }

    const frId = r.rows[0].id;

    await client.query('DELETE FROM friend_requests WHERE id = $1', [frId]);

    await client.query(
      `DELETE FROM trip_shares
       WHERE (shared_by = $1 AND shared_with = $2)
          OR (shared_by = $2 AND shared_with = $1)`,
      [userId, otherId]
    );

    await client.query('COMMIT');

    res.json({ message: 'Relación eliminada y viajes compartidos revocados' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /:userId error:', err);
    res.status(500).json({ message: 'Error' });
  } finally {
    client.release();
  }
});

/**
 * GET /
 * List accepted friends (now includes username)
 */
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const q = `
      SELECT u.id, u.name, u.username, u.email
      FROM users u
      JOIN (
        SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
        FROM friend_requests
        WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'
      ) fr ON fr.friend_id = u.id
      ORDER BY u.name
    `;
    const rows = await pool.query(q, [userId]);
    res.json(rows.rows);
  } catch (err) {
    console.error('GET / error (list friends):', err);
    res.status(500).json({ message: 'Error' });
  }
});

router.get('/:friendId', auth, async (req, res) => {
  const userId = req.user?.id || req.user?.userId;
  const friendId = Number(req.params.friendId);

  if (!userId) return res.status(401).json({ message: 'No autenticado' });
  if (!Number.isFinite(friendId)) return res.status(400).json({ message: 'ID inválido' });

  const friendship = await pool.query(
    `
    SELECT 1
    FROM friend_requests
    WHERE status = 'accepted'
      AND (
        (requester_id = $1 AND addressee_id = $2)
        OR
        (requester_id = $2 AND addressee_id = $1)
      )
    LIMIT 1
    `,
    [userId, friendId]
  );

  if (!friendship.rows.length) return res.status(403).json({ message: 'No son amigos' });

  const u = await pool.query(
    `
      SELECT id, name, username, email, phone, nationality, birthdate
      FROM users
      WHERE id = $1
    `,
    [friendId]
  );

  if (!u.rows.length) return res.status(404).json({ message: 'Usuario no encontrado' });

  res.json(u.rows[0]);
});

module.exports = router;
