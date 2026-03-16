// ---------------------------------------------------
// Payment routes: View payment, raise dispute
// GET  /payments/:job_id       — View payment for a job
// POST /payments/:job_id/dispute — Raise a dispute
// ---------------------------------------------------

const express = require('express');
const pool = require('../db/pool');
const authenticate = require('../middleware/auth');
const { disputePayment } = require('../services/payments');

const router = express.Router();

router.use(authenticate);

// ========================
// GET /payments/:job_id — View payment details for a job
// ========================
router.get('/:job_id', async (req, res) => {
  try {
    // Get the job to verify the user is involved
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

    // Get payment details
    const paymentResult = await pool.query(
      'SELECT * FROM payments WHERE job_id = $1',
      [req.params.job_id]
    );

    if (paymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'No payment found for this job.' });
    }

    const payment = paymentResult.rows[0];

    res.json({
      payment: {
        id: payment.id,
        job_id: payment.job_id,
        amount_cents: payment.amount_cents,
        platform_fee_cents: payment.platform_fee_cents,
        worker_payout_cents: payment.amount_cents - payment.platform_fee_cents,
        currency: payment.currency,
        status: payment.status,
        created_at: payment.created_at,
        updated_at: payment.updated_at,
      },
    });
  } catch (err) {
    console.error('Get payment error:', err);
    res.status(500).json({ error: 'Failed to fetch payment details.' });
  }
});

// ========================
// POST /payments/:job_id/dispute — Raise a payment dispute
// ========================
router.post('/:job_id/dispute', async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'A reason for the dispute is required.' });
    }

    // Get the job to verify the user is involved
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

    // Can only dispute jobs that are in_progress or completed
    if (!['in_progress', 'completed'].includes(job.status)) {
      return res.status(400).json({
        error: 'Disputes can only be raised for jobs that are in progress or completed.',
      });
    }

    // Mark the payment as disputed
    const result = await disputePayment(req.params.job_id);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Log the dispute reason as a chat message for the admin to review
    await pool.query(
      `INSERT INTO chat_messages (job_id, sender_id, body)
       VALUES ($1, $2, $3)`,
      [req.params.job_id, req.user.id, `[DISPUTE] ${reason}`]
    );

    res.json({
      message: 'Dispute raised. Our team will review it shortly.',
      status: 'disputed',
    });
  } catch (err) {
    console.error('Dispute error:', err);
    res.status(500).json({ error: 'Failed to raise dispute.' });
  }
});

module.exports = router;
