// ---------------------------------------------------
// Authentication middleware
// Checks for a valid JWT token in the Authorization header.
// If valid, attaches the user info to req.user so routes can use it.
// ---------------------------------------------------

const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  // Expect header: Authorization: Bearer <token>
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided. Please log in.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

module.exports = authenticate;
