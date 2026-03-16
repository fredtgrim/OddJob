// ---------------------------------------------------
// Notification routes
// GET  /notifications        — get my notifications
// GET  /notifications/unread — get unread count
// PATCH /notifications/read  — mark all as read
// ---------------------------------------------------

const express = require('express');
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const router = express.Router();

// ========================
// GET MY NOTIFICATIONS
// ========================
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.*, p.display_name AS from_user_name
       FROM notifications n
       LEFT JOIN profiles p ON p.user_id = n.from_user_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ========================
// GET UNREAD COUNT
// ========================
router.get('/unread', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Get unread count error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ========================
// MARK ALL AS READ
// ========================
router.patch('/read', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
