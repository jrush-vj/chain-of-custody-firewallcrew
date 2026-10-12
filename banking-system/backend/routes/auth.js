import express from 'express';
import { User } from '../models/User.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  registerValidation,
  loginValidation,
  twoFactorValidation
} from '../middleware/validation.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import {
  createTwoFactorSecret,
  verifyTwoFactorToken,
  formatSecretForDisplay,
  buildOtpAuthUrl
} from '../utils/twoFactor.js';
import {
  createPendingTwoFactorToken,
  createSessionToken,
  verifyToken,
  getPendingTtlMinutes,
  getSessionTtlMinutes
} from '../utils/tokens.js';
import {
  clearPendingTwoFactorCookie,
  clearSessionCookie,
  getPendingTwoFactorCookieName,
  setPendingTwoFactorCookie,
  setSessionCookie
} from '../utils/cookies.js';
import { encryptText, decryptText } from '../utils/crypto.js';

const router = express.Router();

const toPublicUser = (user) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  created_at: user.created_at,
  two_factor_enabled: Boolean(user.two_factor_enabled)
});

const issuePendingCookie = (res, user, intent) => {
  const pendingToken = createPendingTwoFactorToken(user, intent);
  setPendingTwoFactorCookie(res, pendingToken, getPendingTtlMinutes());
};

const issueSession = (res, user) => {
  const sessionToken = createSessionToken(user);
  setSessionCookie(res, sessionToken, getSessionTtlMinutes());
};

const resolvePendingUser = async (req) => {
  const pendingToken = req.cookies?.[getPendingTwoFactorCookieName()];
  if (!pendingToken) {
    return null;
  }

  try {
    const payload = verifyToken(pendingToken);
    return await User.findByIdWithSensitive(payload.sub);
  } catch {
    return null;
  }
};

const ensureTwoFactorSecret = async (user) => {
  if (user.two_factor_secret) {
    const plainSecret = decryptText(user.two_factor_secret);
    return {
      secret: plainSecret,
      otpauthUrl: buildOtpAuthUrl(plainSecret, user.email)
    };
  }

  const { secret, otpauthUrl } = createTwoFactorSecret(user.email);
  const encryptedSecret = encryptText(secret);
  await User.updateTwoFactorSecret(user.id, encryptedSecret);
  user.two_factor_enabled = false;
  user.two_factor_secret = encryptedSecret;

  return { secret, otpauthUrl };
};

const twoFactorResponse = (status, { otpauthUrl = null, secret = null } = {}) => {
  const response = {
    status,
    expiresInMinutes: getPendingTtlMinutes()
  };

  if (status === 'setup' && secret) {
    response.otpauthUrl = otpauthUrl || null;
    response.manualCode = formatSecretForDisplay(secret);
  }

  return response;
};

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user and start the two-factor setup flow
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - email
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       201:
 *         description: Account created; OTP secret issued for setup
 *       400:
 *         description: Validation error
 */
router.post('/register', authLimiter, registerValidation, async (req, res, next) => {
  try {
    clearSessionCookie(res);

    const { username, email, password } = req.body;
    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const user = await User.create(username, email, password);
    const { secret, otpauthUrl } = await ensureTwoFactorSecret(user);

    issuePendingCookie(res, user, 'setup');

    res.status(201).json({
      message: 'Account created. Complete two-factor setup to finish signing in.',
      user: toPublicUser(user),
      twoFactor: twoFactorResponse('setup', { otpauthUrl, secret })
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate credentials and trigger the OTP challenge
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password accepted; next step required
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', authLimiter, loginValidation, async (req, res, next) => {
  try {
    clearSessionCookie(res);

    const { email, password } = req.body;
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValidPassword = await User.verifyPassword(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    let secretBundle = null;
    if (!user.two_factor_secret || !user.two_factor_enabled) {
      secretBundle = await ensureTwoFactorSecret(user);
      issuePendingCookie(res, user, 'setup');
      return res.json({
        message: 'Finish setting up two-factor authentication to sign in.',
        user: toPublicUser(user),
        twoFactor: twoFactorResponse('setup', secretBundle)
      });
    }

    issuePendingCookie(res, user, 'login');

    return res.json({
      message: 'Two-factor verification required',
      user: toPublicUser(user),
      twoFactor: twoFactorResponse('verify')
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/two-factor/verify:
 *   post:
 *     summary: Verify the OTP code and issue a short-lived session
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *             properties:
 *               code:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: OTP verified successfully
 *       400:
 *         description: Invalid/expired OTP
 *       401:
 *         description: Missing pending challenge
 */
router.post(
  '/two-factor/verify',
  authLimiter,
  twoFactorValidation,
  async (req, res, next) => {
    try {
      const { code } = req.body;
      const pendingUser = await resolvePendingUser(req);

      if (!pendingUser || !pendingUser.two_factor_secret) {
        return res.status(401).json({ error: 'No pending two-factor challenge' });
      }

      const secret = decryptText(pendingUser.two_factor_secret);
      const isValid = verifyTwoFactorToken(secret, code);

      if (!isValid) {
        return res.status(400).json({ error: 'Invalid or expired OTP code' });
      }

      if (!pendingUser.two_factor_enabled) {
        await User.markTwoFactorVerified(pendingUser.id);
        pendingUser.two_factor_enabled = true;
      }

      clearPendingTwoFactorCookie(res);
      issueSession(res, pendingUser);

      const safeUser = await User.findById(pendingUser.id);

      res.json({
        message: 'Two-factor authentication successful',
        user: toPublicUser(safeUser)
      });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        clearPendingTwoFactorCookie(res);
        return res.status(401).json({ error: 'Two-factor challenge expired. Please log in again.' });
      }
      next(error);
    }
  }
);

/**
 * @swagger
 * /api/auth/two-factor/regenerate:
 *   post:
 *     summary: Generate a new OTP secret while the setup challenge is pending
 *     tags: [Authentication]
 *     security: []
 *     responses:
 *       200:
 *         description: Secret rotated
 *       400:
 *         description: No setup flow in progress
 */
router.post('/two-factor/regenerate', authLimiter, async (req, res, next) => {
  try {
    const pendingUser = await resolvePendingUser(req);
    if (!pendingUser || pendingUser.two_factor_enabled) {
      return res
        .status(400)
        .json({ error: 'Two-factor regeneration is only available during setup' });
    }

    const { secret, otpauthUrl } = createTwoFactorSecret(pendingUser.email);
    await User.updateTwoFactorSecret(pendingUser.id, encryptText(secret));

    issuePendingCookie(res, pendingUser, 'setup');

    res.json({
      message: 'Generated a new secret. Configure your authenticator app again.',
      twoFactor: twoFactorResponse('setup', { secret, otpauthUrl })
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/two-factor/cancel:
 *   post:
 *     summary: Cancel the current two-factor challenge and clear pending cookies
 *     tags: [Authentication]
 *     security: []
 *     responses:
 *       200:
 *         description: Challenge cancelled
 */
router.post('/two-factor/cancel', authLimiter, (req, res) => {
  clearPendingTwoFactorCookie(res);
  res.json({ message: 'Two-factor challenge canceled' });
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout the current session (clears http-only cookies)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out
 */
router.post('/logout', authenticateToken, (req, res) => {
  clearSessionCookie(res);
  clearPendingTwoFactorCookie(res);
  res.json({ message: 'Logged out' });
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get the authenticated user profile
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User info
 *       401:
 *         description: Missing/expired session
 */
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(toPublicUser(user));
  } catch (error) {
    next(error);
  }
});

export default router;
