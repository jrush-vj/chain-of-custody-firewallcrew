import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useAuth } from '../../context/AuthContext';
import './Auth.css';

const TwoFactorChallenge = ({ onCancel }) => {
  const {
    twoFactorState,
    verifyTwoFactor,
    regenerateTwoFactorSecret,
    cancelTwoFactorFlow
  } = useAuth();

  const [otp, setOtp] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const isSetup = twoFactorState.status === 'setup';
  const hasChallenge = twoFactorState.status !== 'idle' && !!twoFactorState.user;

  useEffect(() => {
    setOtp('');
    setError('');
  }, [twoFactorState.status, twoFactorState.user?.id]);

  useEffect(() => {
    let isMounted = true;

    if (isSetup && twoFactorState.otpauthUrl) {
      QRCode.toDataURL(twoFactorState.otpauthUrl)
        .then((url) => {
          if (isMounted) {
            setQrCode(url);
          }
        })
        .catch((qrError) => {
          console.error('Failed to generate QR code:', qrError);
          if (isMounted) {
            setQrCode('');
          }
        });
    } else {
      setQrCode('');
    }

    return () => {
      isMounted = false;
    };
  }, [isSetup, twoFactorState.otpauthUrl]);

  if (!hasChallenge) {
    return null;
  }

  const attemptVerification = async (value) => {
    if (submitting) {
      return;
    }

    setError('');
    setSubmitting(true);

    const result = await verifyTwoFactor(value);
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    setOtp('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!otp) {
      return;
    }
    await attemptVerification(otp);
  };

  const handleRegenerate = async () => {
    setError('');
    setRegenerating(true);
    const result = await regenerateTwoFactorSecret();
    setRegenerating(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    setOtp('');
  };

  const handleCancel = async () => {
    await cancelTwoFactorFlow();
    setOtp('');
    setError('');
    if (onCancel) {
      onCancel();
    }
  };

  const instructions = isSetup
    ? 'Scan the QR code with your authenticator app or enter the manual code. Then type the 6-digit code to confirm setup.'
    : 'Open your authenticator app and enter the current 6-digit code to finish signing in.';

  const submitLabel = submitting ? 'Verifying...' : 'Verify code';

  return (
    <div className="two-factor-container">
      <h2>{isSetup ? 'Set up 2-step verification' : 'Two-factor authentication'}</h2>
      <p className="two-factor-description">{instructions}</p>
      <div className="two-factor-user">
        {twoFactorState.user?.email || twoFactorState.user?.username}
      </div>

      {isSetup && (
        <div className="two-factor-setup">
          <div className="two-factor-qr-wrapper">
            {qrCode ? (
              <img
                src={qrCode}
                alt="Scan to configure your authenticator app"
                className="two-factor-qr"
              />
            ) : (
              <div className="two-factor-qr two-factor-qr--placeholder">
                QR code unavailable
              </div>
            )}
          </div>
          <div className="two-factor-manual">
            <span className="two-factor-manual-label">Manual code</span>
            <code className="two-factor-manual-code">{twoFactorState.manualCode}</code>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              {regenerating ? 'Generating...' : 'Generate new secret'}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="two-factor-form">
        <label htmlFor="otp">Authenticator code</label>
        <input
          id="otp"
          name="otp"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          value={otp}
          onChange={(event) => {
            const digitsOnly = event.target.value.replace(/\D/g, '').slice(0, 6);
            setOtp(digitsOnly);

            if (digitsOnly.length === 6) {
              attemptVerification(digitsOnly);
            }
          }}
          required
          disabled={submitting}
        />
        {error && <div className="error-message">{error}</div>}
        <button
          type="submit"
          className="btn-primary"
          disabled={submitting || otp.length !== 6}
        >
          {submitLabel}
        </button>
      </form>

      <div className="two-factor-actions">
        <button
          type="button"
          className="btn-link"
          onClick={handleCancel}
          disabled={submitting || regenerating}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export default TwoFactorChallenge;
