import crypto from 'crypto';
import { encryptText, decryptText, hashSensitiveValue } from './crypto.js';

const ACCOUNT_ENCRYPTION_PREFIX = 'ENC::';
const IBAN_ENCRYPTION_PREFIX = 'IBAN::';

export const encryptAccountNumber = (value) => {
  if (!value) {
    return null;
  }

  const normalized = String(value).replace(/\s+/g, '').toUpperCase();
  return `${ACCOUNT_ENCRYPTION_PREFIX}${encryptText(normalized)}`;
};

export const decryptAccountNumber = (value) => {
  if (!value) {
    return null;
  }

  if (value.startsWith(ACCOUNT_ENCRYPTION_PREFIX)) {
    const payload = value.slice(ACCOUNT_ENCRYPTION_PREFIX.length);
    return decryptText(payload);
  }

  return value;
};

export const hashAccountNumber = (value) => {
  if (!value) {
    return null;
  }

  return hashSensitiveValue(String(value).toUpperCase());
};

export const maskAccountNumber = (value) => {
  if (!value) {
    return '****-****-****';
  }

  const sanitized = value.replace(/\s+/g, '');
  const suffix = sanitized.slice(-4).padStart(4, '*');
  return `****-****-${suffix}`;
};

export const isEncryptedAccountNumber = (value) =>
  typeof value === 'string' && value.startsWith(ACCOUNT_ENCRYPTION_PREFIX);

export const generateIban = (seed = '') => {
  const randomPart = crypto.randomBytes(6).toString('hex').toUpperCase();
  const checksum = crypto
    .createHash('sha1')
    .update(`${seed}-${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return `IBAN${randomPart}${checksum}`;
};

export const encryptIban = (value) => {
  if (!value) {
    return null;
  }

  const normalized = String(value).replace(/\s+/g, '').toUpperCase();
  return `${IBAN_ENCRYPTION_PREFIX}${encryptText(normalized)}`;
};

export const decryptIban = (value) => {
  if (!value) {
    return null;
  }

  if (value.startsWith(IBAN_ENCRYPTION_PREFIX)) {
    const payload = value.slice(IBAN_ENCRYPTION_PREFIX.length);
    return decryptText(payload);
  }

  return value;
};

export const hashIban = (value) => {
  if (!value) {
    return null;
  }

  return hashSensitiveValue(String(value).toUpperCase());
};

export const isEncryptedIban = (value) =>
  typeof value === 'string' && value.startsWith(IBAN_ENCRYPTION_PREFIX);
