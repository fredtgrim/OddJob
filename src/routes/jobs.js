// ---------------------------------------------------
// Job routes: Create, list nearby, view, update status
// All routes require authentication (JWT token)
// ---------------------------------------------------

const express = require('express');
const pool = require('../db/pool');
const authenticate = require('../middleware/auth');
const { isTransitionAllowed } = require('../services/stateMachine');
const { createPaymentHold, capturePayment, cancelPayment } = require('../services/payments');

const router = express.Router();

// All job routes require login
router.use(authenticate);

// ========================
// POST /jobs — Create a new job
// ========================
router.post('/', async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      job_type,
      budget_cents,
      currency,
      latitude,
      longitude,
      address_text,
      radius_km,
      scheduled_at,
    } = req.body;

    // Validation
    if (!title || !description || !category || !budget_cents || !latitude || !longitude) {
      return res.status(400).json({
        error: 'Missing required fields: title, description, category, budget_cents, latitude, longitude',
      });
    }

    // Calculate expiry: 24 hours for standard, 30 min for instant
    const expiryHours = (job_type === 'instant') ? 0.5 : 24;
    const expires_at = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

    const result = await pool.query(
      `INSERT INTO jobs (
        poster_id, title, description, category, job_type,
        budget_cents, currency, latitude, longitude, address_text,
        radius_km, status, scheduled_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        req.user.id,
        title,
        description,
        category,
        job_type || 'standard',
        budget_cents,
        currency || 'AUD',
        latitude,
        longitude,
        address_text || null,
        radius_km || 10,
        'accepting_applications',  // skip 'posted' — go straight to accepting
        scheduled_at || null,
        expires_at,
      ]
    );

    const job = result.rows[0];

    res.status(201).json({
      message: 'Job posted successfully!',
      job,
    });
  } catch (err) {
    console.error('Create job error:', err);
    res.status(500).json({ error: 'Failed to create job.' });
  }
});

// ========================
// GET /jobs/mine — Get all jobs where the user is poster or assigned worker
// ========================
router.get('/mine', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT j.*,
              p.display_name AS poster_name,
              p.avg_rating AS poster_rating
       FROM jobs j
       JOIN profiles p ON p.user_id = j.poster_id
       WHERE j.poster_id = $1 OR j.assigned_worker_id = $1
       ORDER BY j.created_at DESC`,
      [req.user.id]
    );

    res.json({
      count: result.rows.length,
      jobs: result.rows,
    });
  } catch (err) {
    console.error('My jobs error:', err);
    res.status(500).json({ error: 'Failed to fetch your jobs.' });
  }
});

// ========================
// GET /jobs/nearby — Find jobs near a worker
// Query params: lat, lng, radius_km (optional, default 10)
// ========================
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius_km } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng query parameters are required.' });
    }

    const radius = parseFloat(radius_km) || 10;

    const result = await pool.query(
      `SELECT j.*,
              u.email AS poster_email,
              p.display_name AS poster_name,
              p.avg_rating AS poster_rating,
              (
                6371 * acos(
                  cos(radians($1)) * cos(radians(j.latitude)) *
                  cos(radians(j.longitude) - radians($2)) +
                  sin(radians($1)) * sin(radians(j.latitude))
                )
              ) AS distance_km
       FROM jobs j
       JOIN users u ON u.id = j.poster_id
       JOIN profiles p ON p.user_id = j.poster_id
       WHERE j.status = 'accepting_applications'
         AND j.expires_at > now()
         AND (
           6371 * acos(
             cos(radians($1)) * cos(radians(j.latitude)) *
             cos(radians(j.longitude) - radians($2)) +
             sin(radians($1)) * sin(radians(j.latitude))
           )
         ) <= $3
       ORDER BY distance_km ASC
       LIMIT 50`,
      [parseFloat(lat), parseFloat(lng), radius]
    );

    res.json({
      count: result.rows.length,
      jobs: result.rows,
    });
  } catch (err) {
    console.error('Nearby jobs error:', err);
    res.status(500).json({ error: 'Failed to fetch nearby jobs.' });
  }
});

// ========================
// GET /jobs/:id — View a single job (includes payment info)
// ========================
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT j.*,
              p.display_name AS poster_name,
              p.avg_rating AS poster_rating,
              pay.status AS payment_status,
              pay.amount_cents AS payment_amount_cents,
              pay.platform_fee_cents
       FROM jobs j
       JOIN profiles p ON p.user_id = j.poster_id
       LEFT JOIN payments pay ON pay.job_id = j.id
       WHERE j.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    res.json({ job: result.rows[0] });
  } catch (err) {
    console.error('Get job error:', err);
    res.status(500).json({ error: 'Failed to fetch job.' });
  }
});

// ========================
// PATCH /jobs/:id/status — Change job status (state machine enforced)
// Body: { status: "new_status" }
// Now triggers payment capture on completion and cancellation on cancel.
// ========================
router.patch('/:id/status', async (req, res) => {
  try {
    const { status: newStatus } = req.body;

    if (!newStatus) {
      return res.status(400).json({ error: 'New status is required.' });
    }

    // Get current job
    const jobResult = await pool.query(
      'SELECT * FROM jobs WHERE id = $1',
      [req.params.id]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const job = jobResult.rows[0];

    // Only the poster or assigned worker can change status
    if (job.poster_id !== req.user.id && job.assigned_worker_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not authorised to update this job.' });
    }

    // Check the state machine
    if (!isTransitionAllowed(job.status, newStatus)) {
      return res.status(400).json({
        error: `Cannot change status from "${job.status}" to "${newStatus}".`,
      });
    }

    // Update the status
    const updated = await pool.query(
      `UPDATE jobs SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [newStatus, req.params.id]
    );

    // --- PAYMENT TRIGGERS ---
    let paymentResult = null;

    if (newStatus === 'completed') {
      // Job is done — capture the payment (charge the poster, pay the worker)
      paymentResult = await capturePayment(req.params.id);
    } else if (newStatus === 'cancelled') {
      // Job is cancelled — release the payment hold
      paymentResult = await cancelPayment(req.params.id);
    }

    res.json({
      message: `Job status updated to "${newStatus}".`,
      job: updated.rows[0],
      payment: paymentResult || undefined,
    });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Failed to update job status.' });
  }
});

// ========================
// GET /jobs/:id/applicants — Poster views ranked applicants
// ========================
router.get('/:id/applicants', async (req, res) => {
  try {
    const jobResult = await pool.query(
      'SELECT poster_id FROM jobs WHERE id = $1',
      [req.params.id]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    if (jobResult.rows[0].poster_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the job poster can view applicants.' });
    }

    const result = await pool.query(
      `SELECT
          ja.id AS application_id,
          ja.worker_id,
          ja.status,
          ja.distance_km,
          ja.message,
          ja.created_at AS applied_at,
          p.display_name,
          p.avatar_url,
          p.bio,
          p.avg_rating,
          p.jobs_completed,
          (
            (0.5 * COALESCE(p.avg_rating / 5.0, 0)) +
            (0.3 * LEAST(COALESCE(p.jobs_completed, 0) / 100.0, 1.0)) +
            (0.2 * (1.0 - LEAST(COALESCE(ja.distance_km, 10) / 10.0, 1.0)))
          ) AS rank_score
       FROM job_applications ja
       JOIN profiles p ON p.user_id = ja.worker_id
       WHERE ja.job_id = $1
         AND ja.status = 'pending'
       ORDER BY rank_score DESC`,
      [req.params.id]
    );

    res.json({
      count: result.rows.length,
      applicants: result.rows,
    });
  } catch (err) {
    console.error('Get applicants error:', err);
    res.status(500).json({ error: 'Failed to fetch applicants.' });
  }
});

// ========================
// POST /jobs/:id/select/:worker_id — Poster picks a worker
// Now creates a real Stripe payment hold.
// ========================
router.post('/:id/select/:worker_id', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify poster owns this job
    const jobResult = await client.query(
      'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (jobResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job not found.' });
    }

    const job = jobResult.rows[0];

    if (job.poster_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the job poster can select a worker.' });
    }

    if (job.status !== 'accepting_applications') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This job is not currently accepting applications.' });
    }

    // Verify the worker actually applied
    const appResult = await client.query(
      `SELECT id FROM job_applications
       WHERE job_id = $1 AND worker_id = $2 AND status = 'pending'`,
      [req.params.id, req.params.worker_id]
    );

    if (appResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This worker has not applied to this job.' });
    }

    // 1. Accept the chosen worker's application
    await client.query(
      `UPDATE job_applications SET status = 'accepted', updated_at = now()
       WHERE job_id = $1 AND worker_id = $2`,
      [req.params.id, req.params.worker_id]
    );

    // 2. Decline all other applications
    await client.query(
      `UPDATE job_applications SET status = 'declined', updated_at = now()
       WHERE job_id = $1 AND worker_id != $2 AND status = 'pending'`,
      [req.params.id, req.params.worker_id]
    );

    // 3. Assign the worker and update job status
    await client.query(
      `UPDATE jobs SET
        status = 'assigned',
        assigned_worker_id = $1,
        updated_at = now()
       WHERE id = $2`,
      [req.params.worker_id, req.params.id]
    );

    await client.query('COMMIT');

    // 4. Create a Stripe payment hold (outside the DB transaction)
    const paymentResult = await createPaymentHold({
      job_id: req.params.id,
      poster_id: req.user.id,
      worker_id: req.params.worker_id,
      amount_cents: job.budget_cents,
      currency: job.currency,
    });

    res.json({
      message: 'Worker selected! The job is now assigned.',
      assigned_worker_id: req.params.worker_id,
      payment: paymentResult,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Select worker error:', err);
    res.status(500).json({ error: 'Failed to select worker.' });
  } finally {
    client.release();
  }
});

module.exports = router;
