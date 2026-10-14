import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'insecure-default-secret';
const SESSION_TTL_MINUTES = parseInt(process.env.SESSION_TTL_MINUTES || '15', 10);
const PENDING_2FA_TTL_MINUTES = parseInt(process.env.PENDING_2FA_TTL_MINUTES || '5', 10);

const minutesToDuration = (minutes) => `${minutes}m`;

export const createSessionToken = (user) =>
  jwt.sign(
    {
      sub: user.id,
      email: user.email
    },
    JWT_SECRET,
    {
      expiresIn: minutesToDuration(SESSION_TTL_MINUTES)
    }
  );

export const createPendingTwoFactorToken = (user, intent = 'two_factor_challenge') =>
  jwt.sign(
    {
      sub: user.id,
      email: user.email,
      intent
    },
    JWT_SECRET,
    {
      expiresIn: minutesToDuration(PENDING_2FA_TTL_MINUTES)
    }
  );

export const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

export const getSessionTtlMinutes = () => SESSION_TTL_MINUTES;
export const getPendingTtlMinutes = () => PENDING_2FA_TTL_MINUTES;
