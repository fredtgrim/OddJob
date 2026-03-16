// ---------------------------------------------------
// Chat routes: Send and read messages for a job
// GET  /chat/:job_id          — Get chat history
// POST /chat/:job_id          — Send a message
// ---------------------------------------------------

const express = require('express');
const pool = require('../db/pool');
const authenticate = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// ========================
// GET /chat/:job_id — Get chat messages for a job
// ========================
router.get('/:job_id', async (req, res) => {
  try {
    // Verify user is part of this job (poster or assigned worker)
    const jobResult = await pool.query(
      'SELECT poster_id, assigned_worker_id FROM jobs WHERE id = $1',
      [req.params.job_id]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const job = jobResult.rows[0];
    if (req.user.id !== job.poster_id && req.user.id !== job.assigned_worker_id) {
      return res.status(403).json({ error: 'You are not part of this job.' });
    }

    // Get messages
    const result = await pool.query(
      `SELECT cm.*, p.display_name AS sender_name
       FROM chat_messages cm
       JOIN profiles p ON p.user_id = cm.sender_id
       WHERE cm.job_id = $1
       ORDER BY cm.created_at ASC`,
      [req.params.job_id]
    );

    // Mark messages as read for this user
    await pool.query(
      `UPDATE chat_messages SET is_read = TRUE
       WHERE job_id = $1 AND sender_id != $2 AND is_read = FALSE`,
      [req.params.job_id, req.user.id]
    );

    res.json({
      count: result.rows.length,
      messages: result.rows,
    });
  } catch (err) {
    console.error('Get chat error:', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

// ========================
// POST /chat/:job_id — Send a message
// ========================
router.post('/:job_id', async (req, res) => {
  try {
    const { body } = req.body;

    if (!body || body.trim().length === 0) {
      return res.status(400).json({ error: 'Message body cannot be empty.' });
    }

    // Verify user is part of this job
    const jobResult = await pool.query(
      'SELECT poster_id, assigned_worker_id, status FROM jobs WHERE id = $1',
      [req.params.job_id]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const job = jobResult.rows[0];
    if (req.user.id !== job.poster_id && req.user.id !== job.assigned_worker_id) {
      return res.status(403).json({ error: 'You are not part of this job.' });
    }

    // Can only chat on active jobs
    const chatAllowedStatuses = ['assigned', 'in_progress', 'completed'];
    if (!chatAllowedStatuses.includes(job.status)) {
      return res.status(400).json({ error: 'Chat is not available for this job status.' });
    }

    const result = await pool.query(
      `INSERT INTO chat_messages (job_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.params.job_id, req.user.id, body.trim()]
    );

    res.status(201).json({
      message: 'Message sent!',
      chat_message: result.rows[0],
    });
  } catch (err) {
    console.error('Send chat error:', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

module.exports = router;
