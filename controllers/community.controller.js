// controllers/community.controller.js
'use strict';

const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

/**
 * POST /friends
 * Send a friend request.
 * Body: { addressee_id } OR { email }
 */
router.post('/friends', auth, async (req, res) => {
  try {
    const requesterId = req.user.id;
    const { addressee_id, email } = req.body;

    let addresseeId = addressee_id || null;
    if (!addresseeId && email) {
      const u = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
      if (!u.rows.length) return res.status(404).json({ message: 'Usuario no encontrado por email' });
      addresseeId = u.rows[0].id;
    }

    if (!addresseeId) return res.status(400).json({ message: 'addressee_id o email requerido' });
    if (Number(addresseeId) === requesterId) return res.status(400).json({ message: 'No puedes agregarte a ti mismo' });

    // check if exists reverse or already accepted
    const existing = await pool.query(
      'SELECT id, status FROM friend_requests WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1) LIMIT 1',
      [requesterId, addresseeId]
    );

    if (existing.rows.length) {
      const ex = existing.rows[0];
      if (ex.status === 'accepted') return res.status(400).json({ message: 'Ya son amigos' });
      if (ex.status === 'pending') {
        // If reverse pending (addressee sent request to me), accept directly
        if (ex.requester_id === addresseeId && ex.addressee_id === requesterId) {
          await pool.query('UPDATE friend_requests SET status=$1 WHERE id=$2', ['accepted', ex.id]);
          return res.json({ message: 'Solicitud aceptada automáticamente (tenías una solicitud entrante)' });
        }
        return res.status(400).json({ message: 'Ya existe una solicitud pendiente' });
      }
      // if rejected, allow to create new? we'll allow
    }

    const ins = await pool.query(
      'INSERT INTO friend_requests (requester_id, addressee_id, status) VALUES ($1,$2,$3) RETURNING id, requester_id, addressee_id, status, created_at',
      [requesterId, addresseeId, 'pending']
    );

    res.status(201).json({ request: ins.rows[0] });
  } catch (err) {
    console.error('POST /friends error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * GET /friends/requests
 * List incoming friend requests (to the logged user) and outgoing
 */
router.get('/friends/requests', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const incoming = await pool.query(
      `SELECT fr.id, fr.requester_id, u.name as requester_name, u.email as requester_email, fr.created_at
       FROM friend_requests fr
       JOIN users u ON u.id = fr.requester_id
       WHERE fr.addressee_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC
      `,
      [userId]
    );
    const outgoing = await pool.query(
      `SELECT fr.id, fr.addressee_id, u.name as addressee_name, u.email as addressee_email, fr.status, fr.created_at
       FROM friend_requests fr
       JOIN users u ON u.id = fr.addressee_id
       WHERE fr.requester_id = $1
       ORDER BY fr.created_at DESC
      `,
      [userId]
    );
    res.json({ incoming: incoming.rows, outgoing: outgoing.rows });
  } catch (err) {
    console.error('GET /friends/requests error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * POST /friends/:id/accept
 * Accept an incoming request (id = friend_requests.id)
 */
router.post('/friends/:id/accept', auth, async (req, res) => {
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
    console.error('POST /friends/:id/accept error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * POST /friends/:id/reject
 * Reject an incoming request
 */
router.post('/friends/:id/reject', auth, async (req, res) => {
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
    console.error('POST /friends/:id/reject error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * DELETE /friends/:userId
 * Remove friendship between logged user and userId OR cancel outgoing request.
 */
router.delete('/friends/:userId', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const otherId = Number(req.params.userId);

    // Try to find any friend_requests row between the two
    const r = await pool.query(
      'SELECT id FROM friend_requests WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1) LIMIT 1',
      [userId, otherId]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Relación no encontrada' });
    const frId = r.rows[0].id;
    await pool.query('DELETE FROM friend_requests WHERE id = $1', [frId]);
    res.json({ message: 'Relación eliminada' });
  } catch (err) {
    console.error('DELETE /friends/:userId error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * GET /friends
 * List accepted friends (returns user's id, name, email)
 */
router.get('/friends', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const q = `
      SELECT u.id, u.name, u.email
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
    console.error('GET /friends error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

module.exports = router;
