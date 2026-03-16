// ---------------------------------------------------
// Review routes: Submit a review after job completion
// POST /reviews/:job_id  — Leave a review
// ---------------------------------------------------

const express = require('express');
const pool = require('../db/pool');
const authenticate = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// ========================
// POST /reviews/:job_id — Submit a review
// ========================
router.post('/:job_id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }

    // Get the job
    const jobResult = await client.query(
      'SELECT * FROM jobs WHERE id = $1',
      [req.params.job_id]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const job = jobResult.rows[0];

    // Job must be completed
    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'You can only review completed jobs.' });
    }

    // Determine who is reviewing whom
    let direction, reviewee_id;

    if (req.user.id === job.poster_id) {
      direction = 'poster_to_worker';
      reviewee_id = job.assigned_worker_id;
    } else if (req.user.id === job.assigned_worker_id) {
      direction = 'worker_to_poster';
      reviewee_id = job.poster_id;
    } else {
      return res.status(403).json({ error: 'You are not part of this job.' });
    }

    await client.query('BEGIN');

    // Insert the review
    const reviewResult = await client.query(
      `INSERT INTO reviews (job_id, reviewer_id, reviewee_id, direction, rating, comment)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.job_id, req.user.id, reviewee_id, direction, rating, comment || null]
    );

    // Recalculate the reviewee's average rating
    const avgResult = await client.query(
      `SELECT AVG(rating)::NUMERIC(3,2) AS avg_rating, COUNT(*) AS total
       FROM reviews WHERE reviewee_id = $1`,
      [reviewee_id]
    );

    await client.query(
      `UPDATE profiles SET
        avg_rating = $1,
        total_ratings = $2,
        updated_at = now()
       WHERE user_id = $3`,
      [avgResult.rows[0].avg_rating, avgResult.rows[0].total, reviewee_id]
    );

    // If reviewing a worker, also update their jobs_completed count
    if (direction === 'poster_to_worker') {
      await client.query(
        `UPDATE profiles SET
          jobs_completed = (
            SELECT COUNT(*) FROM jobs
            WHERE assigned_worker_id = $1 AND status = 'completed'
          ),
          updated_at = now()
         WHERE user_id = $1`,
        [reviewee_id]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Review submitted! Thank you.',
      review: reviewResult.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    // Duplicate review
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You have already reviewed this job.' });
    }
    console.error('Review error:', err);
    res.status(500).json({ error: 'Failed to submit review.' });
  } finally {
    client.release();
  }
});

module.exports = router;
