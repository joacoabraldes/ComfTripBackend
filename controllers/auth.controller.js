// controllers/auth.controller.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const emailService = require('../services/email.service');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * REGISTER
 * Accepts: { name, username, email, phone, password, nationality, birthdate }
 * - username is optional but recommended.
 * - we check both email and username uniqueness.
 */
router.post('/register', async (req, res) => {
  try {
    const { name, username, email, phone, password, nationality, birthdate } = req.body;

    if (!email && !username) {
      return res.status(400).json({ message: 'Email o username requerido' });
    }
    if (!password) {
      return res.status(400).json({ message: 'Password requerido' });
    }

    // normalize for checks
    const emailNorm = email ? email.trim().toLowerCase() : null;
    const usernameNorm = username ? username.trim() : null;

    // check email uniqueness
    if (emailNorm) {
      const existingEmail = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [emailNorm]);
      if (existingEmail.rows.length) return res.status(400).json({ message: 'Email en uso' });
    }

    // check username uniqueness (case-insensitive)
    if (usernameNorm) {
      const existingUser = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [usernameNorm]);
      if (existingUser.rows.length) return res.status(400).json({ message: 'Nombre de usuario en uso' });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (name, username, email, phone, password_hash, nationality, birthdate)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, username, email`,
      [name || null, usernameNorm, emailNorm, phone || null, hash, nationality || null, birthdate || null]
    );

    const user = result.rows[0];
    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        phone: phone || null,
        nationality: nationality || null,
        birthdate: birthdate || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/**
 * LOGIN
 * Accepts: { identifier, password }
 * - identifier can be username OR email (we search username first).
 * - we use case-insensitive lookups.
 */
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ message: 'Credenciales inválidas' });

    const id = identifier.trim();

    // 1) Try find by username (case-insensitive)
    let rows = await pool.query(
      `SELECT id, name, username, email, password_hash
       FROM users
       WHERE LOWER(username) = LOWER($1)
       LIMIT 1`,
      [id]
    );

    // 2) If not found by username, try by email (case-insensitive)
    if (!rows.rows.length) {
      rows = await pool.query(
        `SELECT id, name, username, email, password_hash
         FROM users
         WHERE LOWER(email) = LOWER($1)
         LIMIT 1`,
        [id.toLowerCase()]
      );
    }

    if (!rows.rows.length) {
      // generic failure (don't leak whether identifier exists)
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    const user = rows.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ message: 'Credenciales inválidas' });

    const token = signToken(user);
    res.json({ token, user: { id: user.id, name: user.name, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/**
 * Ensure password_resets table exists
 * This function is idempotent and safe to call multiple times
 */
const ensurePasswordResetsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        email VARCHAR(200) NOT NULL,
        code VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT fk_pr_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // Create index for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_password_resets_user_email 
      ON password_resets(user_id, email)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_password_resets_expires 
      ON password_resets(expires_at)
    `);
  } catch (tableErr) {
    // Table might already exist, ignore
    if (tableErr.code !== '42P07') { // 42P07 = duplicate_table
      console.error('Error creating password_resets table:', tableErr);
    }
  }
};

/**
 * FORGOT PASSWORD / RECOVER PASSWORD handler
 * Accepts: { email }
 * - Generates a 6-digit verification code
 * - Stores it in database with expiration (10 minutes)
 * - For security, always returns success even if email doesn't exist
 */
const handleForgotPassword = async (req, res) => {
  const client = await pool.connect();
  try {
    const { email } = req.body;
    
    if (!email) {
      client.release();
      return res.status(400).json({ message: 'Email requerido' });
    }

    const emailNorm = email.trim().toLowerCase();

    // Ensure table exists before proceeding
    await ensurePasswordResetsTable();

    // Find user by email
    const rows = await client.query(
      `SELECT id, name, email FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [emailNorm]
    );

    // Always return success for security (don't leak if email exists)
    if (rows.rows.length) {
      const user = rows.rows[0];
      
      // Generate cryptographically secure 6-digit verification code
      const code = crypto.randomInt(100000, 999999).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

      // Use transaction to ensure atomicity
      await client.query('BEGIN');
      try {
        // Delete old codes for this user
        await client.query(
          'DELETE FROM password_resets WHERE user_id = $1 OR expires_at < NOW()', 
          [user.id]
        );

        // Insert new code
        await client.query(
          `INSERT INTO password_resets (user_id, email, code, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [user.id, emailNorm, code, expiresAt]
        );

        await client.query('COMMIT');

        // Send email with code
        const emailSent = await emailService.sendPasswordResetCode(user.email, code, user.name);
        if (!emailSent) {
          // Log code if email fails (for development/debugging)
          console.log(`[auth] Password reset code for ${user.email}: ${code} (email sending failed or disabled)`);
        }
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      }
    }

    // Always return success message (security best practice)
    res.json({
      message: 'Si el email existe en nuestro sistema, recibirás un código de verificación.',
      success: true
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ message: 'Error del servidor' });
  } finally {
    client.release();
  }
};

/**
 * VERIFY CODE AND RESET PASSWORD
 * Accepts: { email, code, newPassword }
 * - Verifies the code
 * - Updates the password
 */
router.post('/reset-password', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, code, newPassword } = req.body;
    
    if (!email || !code || !newPassword) {
      client.release();
      return res.status(400).json({ message: 'Email, código y nueva contraseña requeridos' });
    }

    if (newPassword.length < 6) {
      client.release();
      return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const emailNorm = email.trim().toLowerCase();
    const codeNorm = code.trim();

    // Ensure table exists before proceeding
    await ensurePasswordResetsTable();

    // Use transaction to ensure atomicity
    await client.query('BEGIN');
    try {
      // Find valid reset code
      const resetRows = await client.query(
        `SELECT pr.user_id, pr.code, u.email
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
         WHERE LOWER(pr.email) = $1 
           AND pr.code = $2 
           AND pr.expires_at > NOW()
         ORDER BY pr.created_at DESC
         LIMIT 1`,
        [emailNorm, codeNorm]
      );

      if (!resetRows.rows.length) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ message: 'Código inválido o expirado' });
      }

      const reset = resetRows.rows[0];
      const userId = reset.user_id;

      // Hash new password
      const hash = await bcrypt.hash(newPassword, 10);

      // Update user password
      await client.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [hash, userId]
      );

      // Delete used reset code
      await client.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);

      await client.query('COMMIT');

      res.json({
        message: 'Contraseña actualizada correctamente',
        success: true
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// Forgot password endpoint
router.post('/forgot-password', handleForgotPassword);

// Recover password endpoint (alias)
router.post('/recover-password', handleForgotPassword);

module.exports = router;

