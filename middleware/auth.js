// middleware/auth.js
const jwt = require('jsonwebtoken');
const secret = process.env.JWT_SECRET || 'devsecret';

module.exports = function(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: 'No token' });
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, secret);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token inválido' });
  }
};
