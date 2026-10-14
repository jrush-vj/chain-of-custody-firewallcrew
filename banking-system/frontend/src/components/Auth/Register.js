import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import TwoFactorChallenge from './TwoFactorChallenge';
import './Auth.css';

const passwordRequirements = [
  { id: 'length', label: 'Min. 8 characters', test: (value) => value.length >= 8 },
  { id: 'uppercase', label: 'Include uppercase letter', test: (value) => /[A-Z]/.test(value) },
  { id: 'lowercase', label: 'Include lowercase letter', test: (value) => /[a-z]/.test(value) },
  { id: 'digit', label: 'Include a digit', test: (value) => /[0-9]/.test(value) },
  {
    id: 'special',
    label: 'Include special character',
    test: (value) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(value)
  }
];

const Register = () => {
  const { register, user, authError, twoFactorState, cancelTwoFactorFlow } = useAuth();
  const [form, setForm] = useState({ username: '', email: '', password: '' });
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

  const requirementStatuses = useMemo(
    () =>
      passwordRequirements.map((requirement) => ({
        ...requirement,
        satisfied: requirement.test(form.password)
      })),
    [form.password]
  );

  const handleChange = ({ target }) => {
    setForm((prev) => ({ ...prev, [target.name]: target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus(null);

    if (requirementStatuses.some((req) => !req.satisfied)) {
      setStatus({ type: 'error', message: 'Please meet all password requirements.' });
      return;
    }

    setSubmitting(true);
    const result = await register(form.username, form.email, form.password);
    setSubmitting(false);

    if (result.success && result.stage === 'authenticated') {
      setStatus({ type: 'success', message: 'Account created! Redirecting…' });
      navigate('/dashboard');
    } else if (result.success) {
      setStatus({ type: 'info', message: 'Complete two-factor setup to finalize registration.' });
    } else {
      setStatus({
        type: 'error',
        message: result.error || 'Unable to register with those details.'
      });
    }
  };

  const handleCancel = () => {
    cancelTwoFactorFlow();
    setStatus(null);
  };

  const twoFactorActive = twoFactorState.status !== 'idle';

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-panel__intro">
          <p className="eyebrow">Modern finance OS</p>
          <h1>
            Create a <span>JWT-powered</span> profile
          </h1>
          <p className="subtitle">
            Provision a digital bank account, issue IBANs instantly, and secure it with two-factor
            authentication.
          </p>
          <ul className="auth-highlights">
            <li>Unlimited accounts per organization</li>
            <li>Enterprise-grade access policies</li>
            <li>Live transaction intelligence dashboard</li>
          </ul>
        </div>

        <div className="auth-panel__form">
          <div className={`auth-card${twoFactorActive ? ' two-factor-active' : ''}`}>
            <h2>Create account</h2>
            {status?.message && (
              <div className={`auth-banner ${status.type}`}>{status.message}</div>
            )}
            {twoFactorActive ? (
              <TwoFactorChallenge onCancel={handleCancel} />
            ) : (
              <>
                <form onSubmit={handleSubmit} className="auth-form">
                  <label className="floating-label">
                    <span>Username</span>
                    <input
                      type="text"
                      name="username"
                      value={form.username}
                      onChange={handleChange}
                      placeholder="jane.doe"
                      required
                      minLength={3}
                      disabled={submitting}
                    />
                  </label>
                  <label className="floating-label">
                    <span>Email</span>
                    <input
                      type="email"
                      name="email"
                      value={form.email}
                      onChange={handleChange}
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
                        placeholder="••••••••"
                        required
                        minLength={8}
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
                  <div className="password-meter">
                    {requirementStatuses.map((req) => (
                      <span key={req.id} className={`password-pill ${req.satisfied ? 'pass' : 'fail'}`}>
                        {req.label}
                      </span>
                    ))}
                  </div>

                  <button type="submit" className="btn-primary" disabled={submitting}>
                    {submitting ? 'Creating profile…' : 'Register & issue token'}
                  </button>
                </form>
                <p className="auth-link">
                  Already registered? <Link to="/login">Login here</Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Register;
