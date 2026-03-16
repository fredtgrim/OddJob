// ---------------------------------------------------
// OddJob API Server
// This is the main entry point. Run with: npm start
// ---------------------------------------------------

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

// Import route files
const authRoutes = require('./routes/auth');
const jobRoutes = require('./routes/jobs');
const applicationRoutes = require('./routes/applications');
const reviewRoutes = require('./routes/reviews');
const chatRoutes = require('./routes/chat');
const paymentRoutes = require('./routes/payments');
const profileRoutes = require('./routes/profile');
const notificationRoutes = require('./routes/notifications');

const app = express();

// ========================
// MIDDLEWARE
// ========================
app.use(helmet());                    // Security headers
app.use(cors());                      // Allow cross-origin requests
app.use(express.json());              // Parse JSON request bodies

// ========================
// ROUTES
// ========================
app.use('/auth', authRoutes);                 // /auth/register, /auth/login
app.use('/jobs', jobRoutes);                  // /jobs, /jobs/nearby, /jobs/:id, etc.
app.use('/applications', applicationRoutes);  // /applications/:job_id/apply, etc.
app.use('/reviews', reviewRoutes);            // /reviews/:job_id
app.use('/chat', chatRoutes);                 // /chat/:job_id
app.use('/payments', paymentRoutes);           // /payments/:job_id, /payments/:job_id/dispute
app.use('/profile', profileRoutes);            // /profile/me, /profile/:user_id
app.use('/notifications', notificationRoutes); // /notifications, /notifications/unread, /notifications/read

// Health check endpoint (useful for monitoring)
app.get('/', (req, res) => {
  res.json({
    name: 'OddJob API',
    version: '1.0.0',
    status: 'running',
  });
});

// ========================
// START SERVER
// ========================
const PORT = process.env.PORT || 3000;

// Auto-setup database tables on startup, then start server
const pool = require('./db/pool');
const { setupSQL } = require('./db/setup');

async function startServer() {
  try {
    await pool.query(setupSQL);
    console.log('Database tables ready!');
  } catch (err) {
    console.log('Database setup note:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`
  =============================================
    OddJob API is running on port ${PORT}
  =============================================
    `);
  });
}

startServer();
