import { getSessionCookieName } from '../utils/cookies.js';
import { verifySessionToken } from '../utils/tokens.js';

export const authenticateToken = (req, res, next) => {
  const cookieToken = req.cookies?.[getSessionCookieName()];
  let token = cookieToken;

  if (!token) {
    const authHeader = req.headers['authorization'];
    const [scheme, value] = String(authHeader || '').split(' ');
    token = scheme === 'Bearer' ? value : null;
  }

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  let payload;
  try {
    payload = verifySessionToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = {
    id: payload.sub,
    email: payload.email
  };
  next();
};
