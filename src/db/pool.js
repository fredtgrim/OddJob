// ---------------------------------------------------
// Database connection pool
// This file creates a single shared connection to PostgreSQL.
// Every other file that needs the database imports this.
// ---------------------------------------------------

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Log when we successfully connect (helpful for debugging)
pool.on('connect', () => {
  console.log('Connected to PostgreSQL');
});

// Log errors so they don't crash the server silently
pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

module.exports = pool;
