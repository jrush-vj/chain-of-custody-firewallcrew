const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'banking_session';
const PENDING_COOKIE_NAME = process.env.P2FA_COOKIE_NAME || 'banking_pending_2fa';
const isProduction = process.env.NODE_ENV === 'production';
const secureCookie =
  process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && isProduction);

const baseCookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: secureCookie,
  path: '/'
};

export const buildCookieOptions = (maxAgeMinutes) => ({
  ...baseCookieOptions,
  maxAge: maxAgeMinutes * 60 * 1000
});

export const setSessionCookie = (res, token, maxAgeMinutes) => {
  res.cookie(SESSION_COOKIE_NAME, token, buildCookieOptions(maxAgeMinutes));
};

export const clearSessionCookie = (res) => {
  res.clearCookie(SESSION_COOKIE_NAME, baseCookieOptions);
};

export const setPendingTwoFactorCookie = (res, token, maxAgeMinutes) => {
  res.cookie(PENDING_COOKIE_NAME, token, buildCookieOptions(maxAgeMinutes));
};

export const clearPendingTwoFactorCookie = (res) => {
  res.clearCookie(PENDING_COOKIE_NAME, baseCookieOptions);
};

export const getSessionCookieName = () => SESSION_COOKIE_NAME;
export const getPendingTwoFactorCookieName = () => PENDING_COOKIE_NAME;
