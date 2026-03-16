// ---------------------------------------------------
// Profile routes
// GET /profile/me       — get your own profile + stats
// GET /profile/:user_id — get another user's profile
// ---------------------------------------------------

const express = require('express');
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const router = express.Router();

// ========================
// GET MY PROFILE (requires login)
// ========================
router.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.phone,
         u.role,
         u.created_at AS member_since,
         p.display_name,
         p.avatar_url,
         p.bio,
         p.avg_rating,
         p.total_ratings,
         p.jobs_completed
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    // Count jobs posted by this user
    const postedResult = await pool.query(
      `SELECT COUNT(*) AS jobs_posted FROM jobs WHERE poster_id = $1`,
      [req.user.id]
    );

    // Get recent reviews ABOUT this user
    const reviewsResult = await pool.query(
      `SELECT r.rating, r.comment, r.created_at, p.display_name AS reviewer_name
       FROM reviews r
       JOIN profiles p ON p.user_id = r.reviewer_id
       WHERE r.reviewee_id = $1
       ORDER BY r.created_at DESC
       LIMIT 5`,
      [req.user.id]
    );

    const profile = result.rows[0];
    profile.jobs_posted = parseInt(postedResult.rows[0].jobs_posted);
    profile.recent_reviews = reviewsResult.rows;

    res.json({ profile });
  } catch (err) {
    console.error('Get my profile error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ========================
// UPDATE MY PROFILE (requires login)
// ========================
router.patch('/me', auth, async (req, res) => {
  try {
    const { display_name, bio, phone } = req.body;

    // Update profile table (display_name, bio)
    if (display_name || bio !== undefined) {
      const fields = [];
      const values = [];
      let idx = 1;

      if (display_name) {
        fields.push(`display_name = $${idx++}`);
        values.push(display_name.trim());
      }
      if (bio !== undefined) {
        fields.push(`bio = $${idx++}`);
        values.push(bio.trim());
      }

      fields.push(`updated_at = now()`);
      values.push(req.user.id);

      await pool.query(
        `UPDATE profiles SET ${fields.join(', ')} WHERE user_id = $${idx}`,
        values
      );
    }

    // Update users table (phone)
    if (phone) {
      await pool.query(
        `UPDATE users SET phone = $1, updated_at = now() WHERE id = $2`,
        [phone.trim(), req.user.id]
      );
    }

    res.json({ message: 'Profile updated successfully!' });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ========================
// GET OTHER USER'S PROFILE (requires login)
// ========================
router.get('/:user_id', auth, async (req, res) => {
  try {
    const { user_id } = req.params;

    const result = await pool.query(
      `SELECT
         u.id,
         u.created_at AS member_since,
         p.display_name,
         p.avatar_url,
         p.bio,
         p.avg_rating,
         p.total_ratings,
         p.jobs_completed
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Count jobs posted by this user
    const postedResult = await pool.query(
      `SELECT COUNT(*) AS jobs_posted FROM jobs WHERE poster_id = $1`,
      [user_id]
    );

    // Get recent reviews ABOUT this user
    const reviewsResult = await pool.query(
      `SELECT r.rating, r.comment, r.created_at, p.display_name AS reviewer_name
       FROM reviews r
       JOIN profiles p ON p.user_id = r.reviewer_id
       WHERE r.reviewee_id = $1
       ORDER BY r.created_at DESC
       LIMIT 5`,
      [user_id]
    );

    const profile = result.rows[0];
    profile.jobs_posted = parseInt(postedResult.rows[0].jobs_posted);
    profile.recent_reviews = reviewsResult.rows;

    res.json({ profile });
  } catch (err) {
    console.error('Get user profile error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
