// ---------------------------------------------------
// Database setup script
// Can be run standalone:  npm run db:setup
// Also imported by server.js for auto-setup on deploy
// ---------------------------------------------------

const pool = require('./pool');

const setupSQL = `

-- =============================================
-- 1. ENUM TYPES
-- =============================================

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('poster', 'worker', 'both');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM (
    'posted',
    'accepting_applications',
    'assigned',
    'in_progress',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE job_type AS ENUM ('standard', 'instant');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE application_status AS ENUM (
    'pending',
    'accepted',
    'declined',
    'withdrawn'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE review_direction AS ENUM ('poster_to_worker', 'worker_to_poster');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM (
    'hold_created',
    'captured',
    'refunded',
    'disputed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- =============================================
-- 2. TABLES
-- =============================================

-- Users
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    phone           VARCHAR(20)  UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            user_role    NOT NULL DEFAULT 'both',
    is_verified     BOOLEAN      NOT NULL DEFAULT FALSE,
    stripe_customer_id   VARCHAR(255),
    stripe_connect_id    VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Profiles
CREATE TABLE IF NOT EXISTS profiles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name    VARCHAR(100) NOT NULL,
    avatar_url      VARCHAR(500),
    bio             TEXT,
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    location_updated_at  TIMESTAMPTZ,
    avg_rating      NUMERIC(3,2) NOT NULL DEFAULT 0.00,
    total_ratings   INTEGER      NOT NULL DEFAULT 0,
    jobs_completed  INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Jobs
CREATE TABLE IF NOT EXISTS jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poster_id       UUID         NOT NULL REFERENCES users(id),
    title           VARCHAR(200) NOT NULL,
    description     TEXT         NOT NULL,
    category        VARCHAR(50)  NOT NULL,
    job_type        job_type     NOT NULL DEFAULT 'standard',
    budget_cents    INTEGER      NOT NULL,
    currency        VARCHAR(3)   NOT NULL DEFAULT 'AUD',
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    address_text    VARCHAR(500),
    radius_km       NUMERIC(5,2) NOT NULL DEFAULT 10.00,
    status          job_status   NOT NULL DEFAULT 'posted',
    max_applicants  INTEGER      NOT NULL DEFAULT 5,
    assigned_worker_id  UUID REFERENCES users(id),
    instant_cancel_deadline  TIMESTAMPTZ,
    scheduled_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Job Applications
CREATE TABLE IF NOT EXISTS job_applications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id),
    worker_id       UUID NOT NULL REFERENCES users(id),
    status          application_status NOT NULL DEFAULT 'pending',
    distance_km     NUMERIC(6,2),
    message         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(job_id, worker_id)
);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id),
    reviewer_id     UUID NOT NULL REFERENCES users(id),
    reviewee_id     UUID NOT NULL REFERENCES users(id),
    direction       review_direction NOT NULL,
    rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(job_id, reviewer_id)
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id              UUID UNIQUE NOT NULL REFERENCES jobs(id),
    poster_id           UUID NOT NULL REFERENCES users(id),
    worker_id           UUID REFERENCES users(id),
    amount_cents        INTEGER NOT NULL,
    platform_fee_cents  INTEGER NOT NULL DEFAULT 0,
    currency            VARCHAR(3) NOT NULL DEFAULT 'AUD',
    stripe_payment_intent_id  VARCHAR(255),
    status              payment_status NOT NULL DEFAULT 'hold_created',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat Messages
CREATE TABLE IF NOT EXISTS chat_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id),
    sender_id       UUID NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    type            VARCHAR(50) NOT NULL,
    title           VARCHAR(200) NOT NULL,
    body            TEXT,
    job_id          UUID REFERENCES jobs(id),
    from_user_id    UUID REFERENCES users(id),
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =============================================
-- 3. INDEXES
-- =============================================

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_poster ON jobs(poster_id);
CREATE INDEX IF NOT EXISTS idx_applications_job ON job_applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_worker ON job_applications(worker_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS idx_chat_job ON chat_messages(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at);

`;

// Export the SQL so server.js can use it
module.exports = { setupSQL };

// If run directly (npm run db:setup), execute and close
if (require.main === module) {
  (async () => {
    console.log('Setting up OddJob database...');
    try {
      await pool.query(setupSQL);
      console.log('All tables created successfully!');
    } catch (err) {
      console.error('Error setting up database:', err.message);
    } finally {
      await pool.end();
    }
  })();
}
