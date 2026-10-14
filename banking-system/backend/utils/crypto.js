import crypto from 'crypto';

const deriveEncryptionKey = () => {
  const baseSecret = process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!baseSecret) {
    throw new Error(
      'DATA_ENCRYPTION_KEY (or JWT_SECRET fallback) is required for encrypting sensitive data'
    );
  }

  return crypto.createHash('sha256').update(baseSecret).digest();
};

const key = deriveEncryptionKey();
const IV_LENGTH = 12; // AES-GCM recommended IV size
const AUTH_TAG_LENGTH = 16;

export const encryptText = (plainText = '') => {
  if (plainText === null || plainText === undefined) {
    return null;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
};

export const decryptText = (payload) => {
  if (!payload) {
    return null;
  }

  const buffer = Buffer.from(payload, 'base64');
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString('utf8');
};

export const hashSensitiveValue = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  return crypto.createHash('sha256').update(String(value)).digest('hex');
};
