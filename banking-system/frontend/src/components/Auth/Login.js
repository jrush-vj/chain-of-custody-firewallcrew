import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import TwoFactorChallenge from './TwoFactorChallenge';
import './Auth.css';

const Login = () => {
  const { login, user, authError, twoFactorState, cancelTwoFactorFlow } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (user && twoFactorState.status === 'idle') {
      navigate('/dashboard');
    }
  }, [user, twoFactorState.status, navigate]);

  useEffect(() => {
    if (authError) {
      setStatus({ type: 'error', message: authError });
    }
  }, [authError]);

  const handleChange = ({ target }) => {
    setForm((prev) => ({ ...prev, [target.name]: target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus(null);
    setSubmitting(true);

    const result = await login(form.email, form.password);
    setSubmitting(false);

    if (result.success && result.stage === 'authenticated') {
      setStatus({ type: 'success', message: 'Welcome back! Redirecting to your dashboard.' });
      navigate('/dashboard');
    } else if (result.success) {
      setStatus({ type: 'info', message: 'A two-factor challenge is in progress.' });
    } else {
      setStatus({
        type: 'error',
        message: result.error || 'Unable to login with those credentials.'
      });
    }
  };

  const handleCancelTwoFactor = () => {
    cancelTwoFactorFlow();
    setStatus(null);
  };

  const twoFactorActive = twoFactorState.status !== 'idle';

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-panel__intro">
          <p className="eyebrow">Secure banking suite</p>
          <h1>
            Sign in with <span>2-FA Authentication</span>
          </h1>
          <p className="subtitle">
            Use your email and password and unlock the complete banking workspace — 
            two-factor verification keeps your session locked down 🔒
          </p>
          <ul className="auth-highlights">
            <li>Realtime balances & transfers</li>
            <li>Biometric-grade encryption at rest</li>
            <li>Granular audit trail for every movement</li>
          </ul>
        </div>

        <div className="auth-panel__form">
          <div className={`auth-card${twoFactorActive ? ' two-factor-active' : ''}`}>
            <h2>Welcome back</h2>
            {status?.message && (
              <div className={`auth-banner ${status.type}`}>{status.message}</div>
            )}
            {twoFactorActive ? (
              <TwoFactorChallenge onCancel={handleCancelTwoFactor} />
            ) : (
              <>
                <form onSubmit={handleSubmit} className="auth-form">
                  <label className="floating-label">
                    <span>Email</span>
                    <input
                      type="email"
                      name="email"
                      value={form.email}
                      onChange={handleChange}
                      autoComplete="username"
                      placeholder="you@email.com"
                      required
                      disabled={submitting}
                    />
                  </label>
                  <label className="floating-label">
                    <span>Password</span>
                    <div className="password-field">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        name="password"
                        value={form.password}
                        onChange={handleChange}
                        autoComplete="current-password"
                        placeholder="••••••••"
                        required
                        disabled={submitting}
                      />
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setShowPassword((prev) => !prev)}
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </label>

                  <button type="submit" className="btn-primary" disabled={submitting}>
                    {submitting ? 'Authenticating…' : 'Login'}
                  </button>
                </form>
                <p className="auth-link">
                  Need an account? <Link to="/register">Create one in seconds</Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
