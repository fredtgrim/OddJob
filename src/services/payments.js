// ---------------------------------------------------
// Payment Service
// Handles all Stripe interactions:
//   - Creating payment holds (authorize but don't charge yet)
//   - Capturing payments (actually charge after job is done)
//   - Refunding payments (if job is cancelled)
//
// How it works:
//   1. When a poster selects a worker, we CREATE a PaymentIntent
//      with capture_method: 'manual'. This puts a HOLD on the
//      poster's card but doesn't charge them yet.
//   2. When the job is completed, we CAPTURE the PaymentIntent.
//      This actually charges the card and sends money to the worker.
//   3. If the job is cancelled, we CANCEL the PaymentIntent.
//      The hold is released and the poster is not charged.
// ---------------------------------------------------

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool = require('../db/pool');

// Platform fee percentage (e.g. 10% = 0.10)
const PLATFORM_FEE_PERCENT = 0.10;

/**
 * Create a payment hold when a worker is selected.
 * The poster's card is authorized but NOT charged yet.
 */
async function createPaymentHold({ job_id, poster_id, worker_id, amount_cents, currency }) {
  try {
    // Look up the poster's Stripe customer ID
    const posterResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [poster_id]
    );

    // Look up the worker's Stripe Connect account
    const workerResult = await pool.query(
      'SELECT stripe_connect_id FROM users WHERE id = $1',
      [worker_id]
    );

    const platform_fee_cents = Math.round(amount_cents * PLATFORM_FEE_PERCENT);

    // Create a PaymentIntent with manual capture (hold only)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount_cents,
      currency: currency.toLowerCase(),
      capture_method: 'manual',  // THIS IS THE KEY — hold, don't charge
      metadata: {
        job_id,
        poster_id,
        worker_id,
      },
      // If the worker has a Stripe Connect account, set up the split
      ...(workerResult.rows[0]?.stripe_connect_id && {
        transfer_data: {
          destination: workerResult.rows[0].stripe_connect_id,
          amount: amount_cents - platform_fee_cents,  // Worker gets this
        },
      }),
    });

    // Save payment record in our database
    await pool.query(
      `INSERT INTO payments (job_id, poster_id, worker_id, amount_cents, platform_fee_cents, currency, stripe_payment_intent_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'hold_created')
       ON CONFLICT (job_id) DO UPDATE SET
         worker_id = $3,
         stripe_payment_intent_id = $7,
         status = 'hold_created',
         updated_at = now()`,
      [job_id, poster_id, worker_id, amount_cents, platform_fee_cents, currency, paymentIntent.id]
    );

    return {
      success: true,
      payment_intent_id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,  // Frontend needs this to confirm the card
    };
  } catch (err) {
    console.error('Create payment hold error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Capture the payment after a job is completed.
 * This actually charges the poster and sends money to the worker.
 */
async function capturePayment(job_id) {
  try {
    // Get the payment record
    const paymentResult = await pool.query(
      'SELECT * FROM payments WHERE job_id = $1',
      [job_id]
    );

    if (paymentResult.rows.length === 0) {
      return { success: false, error: 'No payment found for this job.' };
    }

    const payment = paymentResult.rows[0];

    if (!payment.stripe_payment_intent_id) {
      // No Stripe ID means we're in test mode without real Stripe
      // Just update the status in our database
      await pool.query(
        `UPDATE payments SET status = 'captured', updated_at = now() WHERE job_id = $1`,
        [job_id]
      );
      return { success: true, mode: 'test' };
    }

    // Capture the held funds on Stripe
    await stripe.paymentIntents.capture(payment.stripe_payment_intent_id);

    // Update our database
    await pool.query(
      `UPDATE payments SET status = 'captured', updated_at = now() WHERE job_id = $1`,
      [job_id]
    );

    return { success: true };
  } catch (err) {
    console.error('Capture payment error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Cancel/refund a payment hold (e.g. job is cancelled).
 * Releases the hold on the poster's card.
 */
async function cancelPayment(job_id) {
  try {
    const paymentResult = await pool.query(
      'SELECT * FROM payments WHERE job_id = $1',
      [job_id]
    );

    if (paymentResult.rows.length === 0) {
      return { success: true };  // No payment to cancel
    }

    const payment = paymentResult.rows[0];

    if (payment.stripe_payment_intent_id) {
      // Cancel the PaymentIntent on Stripe (releases the hold)
      await stripe.paymentIntents.cancel(payment.stripe_payment_intent_id);
    }

    // Update our database
    await pool.query(
      `UPDATE payments SET status = 'refunded', updated_at = now() WHERE job_id = $1`,
      [job_id]
    );

    return { success: true };
  } catch (err) {
    console.error('Cancel payment error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Mark a payment as disputed.
 */
async function disputePayment(job_id) {
  try {
    await pool.query(
      `UPDATE payments SET status = 'disputed', updated_at = now() WHERE job_id = $1`,
      [job_id]
    );
    return { success: true };
  } catch (err) {
    console.error('Dispute payment error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  createPaymentHold,
  capturePayment,
  cancelPayment,
  disputePayment,
  PLATFORM_FEE_PERCENT,
};
