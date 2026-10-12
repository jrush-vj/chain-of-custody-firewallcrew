import jwt from 'jsonwebtoken';
import { getSessionCookieName } from '../utils/cookies.js';

const JWT_SECRET = process.env.JWT_SECRET || 'insecure-default-secret';

export const authenticateToken = (req, res, next) => {
  const cookieToken = req.cookies?.[getSessionCookieName()];
  let token = cookieToken;

  if (!token) {
    const authHeader = req.headers['authorization'];
    token = authHeader && authHeader.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = {
      id: payload.sub || payload.id,
      email: payload.email
    };
    next();
  });
};
