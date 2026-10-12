import { authenticator } from 'otplib';

const OTP_DIGITS = parseInt(process.env.TOTP_DIGITS || '6', 10);
const OTP_PERIOD = parseInt(process.env.TOTP_PERIOD || '30', 10);
const OTP_ISSUER = process.env.TOTP_ISSUER || 'Banking System';
const OTP_WINDOW = parseInt(process.env.TOTP_WINDOW || '1', 10);

authenticator.options = { digits: OTP_DIGITS, step: OTP_PERIOD };

export const buildOtpAuthUrl = (secret, label) =>
  authenticator.keyuri(label || 'user', OTP_ISSUER, secret);

export const createTwoFactorSecret = (label) => {
  const secret = authenticator.generateSecret();
  const otpauthUrl = buildOtpAuthUrl(secret, label);

  return { secret, otpauthUrl };
};

export const verifyTwoFactorToken = (secret, token) => {
  if (!secret || !token) {
    return false;
  }

  return authenticator.verify({ token: String(token), secret, window: OTP_WINDOW });
};

export const formatSecretForDisplay = (secret) =>
  String(secret).replace(/(.{4})/g, '$1 ').trim().toUpperCase();
