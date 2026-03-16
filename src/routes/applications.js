// ---------------------------------------------------
// Application routes: Apply to a job, withdraw
// POST /applications/:job_id/apply   — Worker applies
// POST /applications/:id/withdraw    — Worker withdraws
// ---------------------------------------------------

const express = require('express');
const pool = require('../db/pool');
const authenticate = require('../middleware/auth');

const { createNotification } = require('../services/notify');

const router = express.Router();

router.use(authenticate);

// ========================
// POST /applications/:job_id/apply — Worker applies to a job
// ========================
router.post('/:job_id/apply', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get the job (with lock to prevent race condition on applicant count)
    const jobResult = await client.query(
      'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
      [req.params.job_id]
    );

    if (jobResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job not found.' });
    }

    const job = jobResult.rows[0];

    // Check job is accepting applications
    if (job.status !== 'accepting_applications') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This job is not accepting applications.' });
    }

    // Check expiry
    if (job.expires_at && new Date(job.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This job has expired.' });
    }

    // Can't apply to your own job
    if (job.poster_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot apply to your own job.' });
    }

    // Check if already applied
    const existingApp = await client.query(
      'SELECT id FROM job_applications WHERE job_id = $1 AND worker_id = $2',
      [req.params.job_id, req.user.id]
    );

    if (existingApp.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You have already applied to this job.' });
    }

    // Count current applications (the race-condition-safe check)
    const countResult = await client.query(
      `SELECT COUNT(*) AS current_count
       FROM job_applications
       WHERE job_id = $1 AND status = 'pending'`,
      [req.params.job_id]
    );

    const currentCount = parseInt(countResult.rows[0].current_count, 10);

    if (currentCount >= job.max_applicants) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'This job has reached the maximum number of applicants.',
      });
    }

    // Calculate distance between worker and job
    const workerProfile = await client.query(
      'SELECT latitude, longitude FROM profiles WHERE user_id = $1',
      [req.user.id]
    );

    let distance_km = null;
    if (workerProfile.rows.length > 0 && workerProfile.rows[0].latitude) {
      const wp = workerProfile.rows[0];
      // Haversine formula in JS
      const toRad = (deg) => (deg * Math.PI) / 180;
      const R = 6371; // Earth radius in km
      const dLat = toRad(job.latitude - wp.latitude);
      const dLng = toRad(job.longitude - wp.longitude);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(wp.latitude)) *
          Math.cos(toRad(job.latitude)) *
          Math.sin(dLng / 2) *
          Math.sin(dLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      distance_km = Math.round(R * c * 100) / 100; // 2 decimal places
    }

    // For INSTANT jobs: first applicant auto-wins
    if (job.job_type === 'instant') {
      // Insert as accepted immediately
      await client.query(
        `INSERT INTO job_applications (job_id, worker_id, status, distance_km, message)
         VALUES ($1, $2, 'accepted', $3, $4)`,
        [req.params.job_id, req.user.id, distance_km, req.body.message || null]
      );

      // Assign the job
      const cancelDeadline = new Date(Date.now() + 60 * 1000).toISOString(); // 60 seconds
      await client.query(
        `UPDATE jobs SET
           status = 'assigned',
           assigned_worker_id = $1,
           instant_cancel_deadline = $2,
           updated_at = now()
         WHERE id = $3`,
        [req.user.id, cancelDeadline, req.params.job_id]
      );

      // Create payment hold
      await client.query(
        `INSERT INTO payments (job_id, poster_id, worker_id, amount_cents, currency, status)
         VALUES ($1, $2, $3, $4, $5, 'hold_created')`,
        [req.params.job_id, job.poster_id, req.user.id, job.budget_cents, job.currency]
      );

      await client.query('COMMIT');

      return res.status(201).json({
        message: 'Instant job accepted! You are assigned.',
        status: 'accepted',
        instant_cancel_deadline: cancelDeadline,
      });
    }

    // For STANDARD jobs: add as pending applicant
    const appResult = await client.query(
      `INSERT INTO job_applications (job_id, worker_id, status, distance_km, message)
       VALUES ($1, $2, 'pending', $3, $4)
       RETURNING *`,
      [req.params.job_id, req.user.id, distance_km, req.body.message || null]
    );

    await client.query('COMMIT');

    // Notify the job poster that someone applied
    const workerProfileResult = await pool.query(
      'SELECT display_name FROM profiles WHERE user_id = $1',
      [req.user.id]
    );
    const workerName = workerProfileResult.rows[0]?.display_name || 'Someone';
    createNotification({
      userId: job.poster_id,
      type: 'new_application',
      title: `${workerName} applied to your job`,
      body: job.title,
      jobId: job.id,
      fromUserId: req.user.id,
    });

    res.status(201).json({
      message: 'Application submitted! The job poster will review it.',
      application: appResult.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Apply error:', err);
    res.status(500).json({ error: 'Failed to submit application.' });
  } finally {
    client.release();
  }
});

// ========================
// POST /applications/:id/withdraw — Worker withdraws application
// ========================
router.post('/:id/withdraw', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE job_applications
       SET status = 'withdrawn', updated_at = now()
       WHERE id = $1 AND worker_id = $2 AND status = 'pending'
       RETURNING *`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Application not found or already processed.',
      });
    }

    res.json({
      message: 'Application withdrawn.',
      application: result.rows[0],
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Failed to withdraw application.' });
  }
});

module.exports = router;
