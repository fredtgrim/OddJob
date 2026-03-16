// ---------------------------------------------------
// Job State Machine
// Defines which status transitions are allowed.
// Every status change in the app MUST go through this.
// ---------------------------------------------------

const ALLOWED_TRANSITIONS = {
  posted: ['accepting_applications', 'cancelled'],
  accepting_applications: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'accepting_applications', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/**
 * Check if a job status transition is allowed.
 * @param {string} currentStatus - The job's current status
 * @param {string} newStatus - The status you want to move to
 * @returns {boolean}
 */
function isTransitionAllowed(currentStatus, newStatus) {
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowed) return false;
  return allowed.includes(newStatus);
}

/**
 * Get the list of statuses a job can move to from its current status.
 * @param {string} currentStatus
 * @returns {string[]}
 */
function getNextStatuses(currentStatus) {
  return ALLOWED_TRANSITIONS[currentStatus] || [];
}

module.exports = { isTransitionAllowed, getNextStatuses, ALLOWED_TRANSITIONS };
