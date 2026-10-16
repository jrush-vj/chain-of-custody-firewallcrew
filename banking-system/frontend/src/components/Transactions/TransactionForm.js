import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../lib/apiClient';
import { formatCurrency } from '../../lib/format';
import { PageHeader } from '../Common/Common';
import './TransactionForm.css';

const TYPES = [
  { value: 'deposit', label: 'Deposit', hint: 'Add cash to one of your accounts' },
  { value: 'withdrawal', label: 'Withdraw', hint: 'Take cash out of an account' },
  { value: 'transfer', label: 'Transfer', hint: 'Move money between your accounts' }
];
const QUICK_AMOUNTS = ['50', '100', '250', '500'];
const EMPTY_FORM = { account_id: '', from_account_id: '', to_account_id: '', amount: '' };

const accountOptionLabel = (account) =>
  `${account.account_type.toUpperCase()} · ${account.account_number} · ${formatCurrency(account.balance)}`;

const TransactionForm = () => {
  const [accounts, setAccounts] = useState([]);
  const [type, setType] = useState('deposit');
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [witnessPending, setWitnessPending] = useState(false);
  const [witnessEventId, setWitnessEventId] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const response = await apiClient.get('/api/accounts');
        setAccounts(response.data || []);
      } catch (err) {
        setError('Failed to load accounts');
      }
    };

    fetchAccounts();
  }, []);

  const byId = useMemo(() => new Map(accounts.map((account) => [String(account.id), account])), [accounts]);
  const sourceAccount = byId.get(type === 'transfer' ? formData.from_account_id : formData.account_id);
  const targetAccount = byId.get(type === 'transfer' ? formData.to_account_id : formData.account_id);
  const amountValue = parseFloat(formData.amount);
  const hasAmount = Number.isFinite(amountValue) && amountValue > 0;
  const needsFunds = type !== 'deposit';
  const insufficient =
    needsFunds && sourceAccount && hasAmount && amountValue > parseFloat(sourceAccount.balance || 0);

  const preview = useMemo(() => {
    if (!hasAmount) return null;
    if (type === 'deposit' && targetAccount) {
      return [{ account: targetAccount, after: parseFloat(targetAccount.balance) + amountValue }];
    }
    if (type === 'withdrawal' && sourceAccount) {
      return [{ account: sourceAccount, after: parseFloat(sourceAccount.balance) - amountValue }];
    }
    if (type === 'transfer' && sourceAccount && targetAccount) {
      return [
        { account: sourceAccount, after: parseFloat(sourceAccount.balance) - amountValue },
        { account: targetAccount, after: parseFloat(targetAccount.balance) + amountValue }
      ];
    }
    return null;
  }, [type, sourceAccount, targetAccount, amountValue, hasAmount]);

  const update = (field) => (event) => setFormData((prev) => ({ ...prev, [field]: event.target.value }));

  const handleTypeChange = (nextType) => {
    setType(nextType);
    setFormData(EMPTY_FORM);
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setWitnessPending(false);
    setWitnessEventId('');
    setLoading(true);

    try {
      // Send the amount exactly as typed; the server parses it to cents without float rounding.
      const amount = String(formData.amount).trim();
      let response;

      if (type === 'deposit') {
        response = await apiClient.post('/api/transactions/deposit', {
          account_id: parseInt(formData.account_id, 10),
          amount
        });
      } else if (type === 'withdrawal') {
        response = await apiClient.post('/api/transactions/withdraw', {
          account_id: parseInt(formData.account_id, 10),
          amount
        });
      } else {
        response = await apiClient.post('/api/transactions/transfer', {
          from_account_id: parseInt(formData.from_account_id, 10),
          to_account_id: parseInt(formData.to_account_id, 10),
          amount
        });
      }

      const pending = response?.data?.witness_status !== 'confirmed';
      setWitnessPending(pending);
      setWitnessEventId(response?.data?.witness_event_id || '');
      setSuccess(
        response?.data?.message ||
          (pending
            ? response?.data?.error || 'Witness confirmation is pending. Do not retry blindly.'
            : `${type.charAt(0).toUpperCase() + type.slice(1)} successful!`)
      );
      setFormData(EMPTY_FORM);
      if (!pending) {
        setTimeout(() => {
          navigate('/transactions');
        }, 1500);
      }
    } catch (err) {
      if (err.response?.data?.witness_status) {
        setWitnessPending(true);
        setWitnessEventId(err.response.data.witness_event_id || '');
        setSuccess(
          `${err.response.data.error || err.response.data.message || 'Transaction outcome is uncertain.'} Do not retry blindly.`
        );
        return;
      }
      const errorMessage =
        err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || err.message;
      setError(errorMessage || `Failed to process ${type}`);
    } finally {
      setLoading(false);
    }
  };

  const accountSelect = (id, field, label, exclude) => (
    <label>
      <span>{label}</span>
      <select id={id} value={formData[field]} onChange={update(field)} required>
        <option value="">Select account</option>
        {accounts
          .filter((acc) => String(acc.id) !== exclude)
          .map((acc) => (
            <option key={acc.id} value={acc.id}>
              {accountOptionLabel(acc)}
            </option>
          ))}
      </select>
    </label>
  );

  const activeType = TYPES.find((item) => item.value === type);

  return (
    <div className="transaction-form-page page-grid">
      <PageHeader
        eyebrow="New transaction"
        title="Move money"
        subtitle="Every movement is prepared with the independent witness before it is committed."
      />

      {error && <div className="error-message" role="alert">{error}</div>}
      {success && (
        <div className={witnessPending ? 'pending-message' : 'success-message'} role="status">
          {success}
          {witnessPending && witnessEventId && <div className="mono">Witness event: {witnessEventId}</div>}
        </div>
      )}

      <section className="panel form-card">
        {accounts.length === 0 ? (
          <div className="empty-state">Create an account first to start moving money.</div>
        ) : (
          <form onSubmit={handleSubmit} className="transaction-form">
            <div className="segmented" role="tablist" aria-label="Transaction type">
              {TYPES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={type === item.value}
                  className={type === item.value ? 'active' : ''}
                  onClick={() => handleTypeChange(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="form-hint">{activeType.hint}</p>

            {type === 'deposit' && accountSelect('account_id', 'account_id', 'Destination account')}
            {type === 'withdrawal' && accountSelect('account_id', 'account_id', 'Source account')}
            {type === 'transfer' && (
              <div className="transfer-grid">
                {accountSelect('from_account_id', 'from_account_id', 'From account', formData.to_account_id)}
                {accountSelect('to_account_id', 'to_account_id', 'To account', formData.from_account_id)}
              </div>
            )}

            <label>
              <span>Amount</span>
              <div className="amount-input">
                <span aria-hidden="true">$</span>
                <input
                  type="number"
                  id="amount"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  value={formData.amount}
                  onChange={update('amount')}
                  required
                  placeholder="0.00"
                  aria-invalid={insufficient || undefined}
                />
              </div>
            </label>
            <div className="quick-amounts">
              {QUICK_AMOUNTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="chip"
                  onClick={() => setFormData((prev) => ({ ...prev, amount: value }))}
                >
                  ${value}
                </button>
              ))}
              {needsFunds && sourceAccount && parseFloat(sourceAccount.balance) > 0 && (
                <button
                  type="button"
                  className="chip"
                  onClick={() =>
                    setFormData((prev) => ({
                      ...prev,
                      amount: parseFloat(sourceAccount.balance).toFixed(2)
                    }))
                  }
                >
                  Max
                </button>
              )}
            </div>

            {insufficient && (
              <p className="field-error">
                Insufficient funds: the source account holds {formatCurrency(sourceAccount.balance)}.
              </p>
            )}

            {preview && !insufficient && (
              <div className="balance-preview" aria-live="polite">
                {preview.map(({ account, after }) => (
                  <div key={account.id}>
                    <span className="muted">{account.account_number}</span>
                    <span>
                      {formatCurrency(account.balance)} → <strong>{formatCurrency(after)}</strong>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <button type="submit" className="btn-primary" disabled={loading || insufficient}>
              {loading ? 'Processing…' : hasAmount ? `${activeType.label} ${formatCurrency(amountValue)}` : activeType.label}
            </button>
          </form>
        )}
      </section>
    </div>
  );
};

export default TransactionForm;
