import React, { useEffect, useState } from 'react';
import './Common.css';

const WITNESS_STATES = {
  confirmed: { label: 'Witnessed', hint: 'Sealed and confirmed by the independent witness' },
  pending: { label: 'Pending', hint: 'Recorded locally; the bank is retrying witness confirmation' }
};

export const WitnessBadge = ({ status, compact = false }) => {
  const state = WITNESS_STATES[status];
  if (!state) {
    return (
      <span className="witness-badge none" title="Recorded before the witness integration">
        {compact ? '—' : 'Not witnessed'}
      </span>
    );
  }
  return (
    <span className={`witness-badge ${status}`} title={state.hint}>
      <i aria-hidden="true" />
      {state.label}
    </span>
  );
};

export const CopyButton = ({ value, label = 'Copy' }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className={`copy-button${copied ? ' copied' : ''}`}
      onClick={copy}
      aria-label={`${label}: ${value}`}
    >
      {copied ? 'Copied' : label}
    </button>
  );
};

export const Spinner = ({ label = 'Loading…' }) => (
  <div className="loading" role="status" aria-live="polite">
    <span className="spinner" aria-hidden="true" />
    {label}
  </div>
);

export const Alert = ({ kind = 'error', children, onDismiss }) => (
  <div className={`${kind}-message alert-row`} role={kind === 'error' ? 'alert' : 'status'}>
    <div>{children}</div>
    {onDismiss && (
      <button type="button" className="alert-dismiss" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    )}
  </div>
);

export const PageHeader = ({ eyebrow, title, subtitle, children }) => (
  <header className="page-header-block">
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {subtitle && <p className="subtitle">{subtitle}</p>}
    </div>
    {children && <div className="page-header-actions">{children}</div>}
  </header>
);
