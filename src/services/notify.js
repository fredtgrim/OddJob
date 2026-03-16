// ---------------------------------------------------
// Notification helper
// Call this from any route to create a notification
// ---------------------------------------------------

const pool = require('../db/pool');

async function createNotification({ userId, type, title, body, jobId, fromUserId }) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, job_id, from_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, type, title, body || null, jobId || null, fromUserId || null]
    );
  } catch (err) {
    // Don't crash the main request if notification fails
    console.error('Failed to create notification:', err.message);
  }
}

module.exports = { createNotification };
