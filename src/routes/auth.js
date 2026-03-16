// ---------------------------------------------------
// Auth routes: Register + Login
// POST /auth/register  — create a new account
// POST /auth/login     — get a JWT token
// ---------------------------------------------------

const express = require('express');
const crypto = require('crypto');   // Built into Node.js — no install needed
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const router = express.Router();

// ========================
// Password hashing helpers (using Node's built-in crypto)
// ========================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === testHash;
}

// ========================
// REGISTER
// ========================
router.post('/register', async (req, res) => {
  try {
    const { email, phone, password, display_name, role } = req.body;

    // Basic validation
    if (!email || !phone || !password || !display_name) {
      return res.status(400).json({
        error: 'Missing required fields: email, phone, password, display_name',
      });
    }

    // Check if user already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR phone = $2',
      [email, phone]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email or phone already exists.' });
    }

    // Hash the password
    const password_hash = hashPassword(password);

    // Create user + profile in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `INSERT INTO users (email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, phone, role, created_at`,
        [email, phone, password_hash, role || 'both']
      );

      const user = userResult.rows[0];

      await client.query(
        `INSERT INTO profiles (user_id, display_name)
         VALUES ($1, $2)`,
        [user.id, display_name]
      );

      await client.query('COMMIT');

      // Generate JWT
      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        message: 'Account created successfully!',
        token,
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          role: user.role,
          display_name,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ========================
// LOGIN
// ========================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Find the user
    const result = await pool.query(
      'SELECT id, email, password_hash, role FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];

    // Check password
    const isValid = verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Logged in successfully!',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
