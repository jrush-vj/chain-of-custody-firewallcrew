import 'dotenv/config';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required; set it in banking-system/.env');
}
if (JWT_SECRET.length < 32) {
  console.warn('JWT_SECRET is shorter than 32 characters; use a longer random value.');
}

const SESSION_TTL_MINUTES = parseInt(process.env.SESSION_TTL_MINUTES || '15', 10);
const PENDING_2FA_TTL_MINUTES = parseInt(process.env.PENDING_2FA_TTL_MINUTES || '5', 10);
const ALGORITHM = 'HS256';

// Session and pending-2FA tokens share a secret, so each carries a type that verifiers enforce.
// Without it a password-only pending token would be accepted as a full session (2FA bypass).
const TOKEN_TYPE_SESSION = 'session';
const TOKEN_TYPE_PENDING = 'pending_2fa';

const minutesToDuration = (minutes) => `${minutes}m`;

const sign = (payload, minutes) =>
  jwt.sign(payload, JWT_SECRET, { algorithm: ALGORITHM, expiresIn: minutesToDuration(minutes) });

const verifyTyped = (token, expectedType) => {
  const payload = jwt.verify(token, JWT_SECRET, { algorithms: [ALGORITHM] });
  if (payload.typ !== expectedType) {
    throw new jwt.JsonWebTokenError('Unexpected token type');
  }
  return payload;
};

export const createSessionToken = (user) =>
  sign({ sub: user.id, email: user.email, typ: TOKEN_TYPE_SESSION }, SESSION_TTL_MINUTES);

export const createPendingTwoFactorToken = (user, intent = 'two_factor_challenge') =>
  sign({ sub: user.id, email: user.email, intent, typ: TOKEN_TYPE_PENDING }, PENDING_2FA_TTL_MINUTES);

export const verifySessionToken = (token) => verifyTyped(token, TOKEN_TYPE_SESSION);
export const verifyPendingToken = (token) => verifyTyped(token, TOKEN_TYPE_PENDING);

export const getSessionTtlMinutes = () => SESSION_TTL_MINUTES;
export const getPendingTtlMinutes = () => PENDING_2FA_TTL_MINUTES;
