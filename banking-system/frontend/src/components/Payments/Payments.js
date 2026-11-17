import React, { useEffect, useMemo, useState } from 'react';
import apiClient from '../../lib/apiClient';
import { formatCurrency } from '../../lib/format';
import { PageHeader, Spinner } from '../Common/Common';
import './Payments.css';

const EMPTY_PAYMENT = { recipient_name: '', recipient_iban: '', amount: '', reference: '' };

// Group an IBAN into blocks of four for readability; the server receives it without spaces.
const formatIban = (value) =>
  value
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 34)
    .replace(/(.{4})(?=.)/g, '$1 ');

const Payments = () => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [witnessPending, setWitnessPending] = useState(false);
  const [witnessEventId, setWitnessEventId] = useState('');
  const [formData, setFormData] = useState({ from_account_id: '', ...EMPTY_PAYMENT });

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        setLoading(true);
        const response = await apiClient.get('/api/accounts');
        setAccounts(response.data);
        if (response.data.length > 0) {
          setFormData((prev) => ({
            ...prev,
            from_account_id: response.data[0].id
          }));
        }
      } catch (err) {
        setError('Failed to load accounts');
      } finally {
        setLoading(false);
      }
    };

    fetchAccounts();
  }, []);

  const sourceAccount = useMemo(
    () => accounts.find((account) => String(account.id) === String(formData.from_account_id)),
    [accounts, formData.from_account_id]
  );
  const amountValue = parseFloat(formData.amount);
  const insufficient =
    sourceAccount && Number.isFinite(amountValue) && amountValue > parseFloat(sourceAccount.balance || 0);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({
      ...prev,
      [name]: name === 'recipient_iban' ? formatIban(value) : value
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setSuccess('');
    setWitnessPending(false);
    setWitnessEventId('');

    try {
      const response = await apiClient.post('/api/transactions/external/outgoing', {
        ...formData,
        recipient_iban: formData.recipient_iban.replace(/\s+/g, ''),
        amount: String(formData.amount).trim()
      });
      const pending = response.data.witness_status !== 'confirmed';
      setWitnessPending(pending);
      setWitnessEventId(response.data.witness_event_id || '');
      setSuccess(
        response.data.message ||
          (pending
            ? 'Payment recorded; witness confirmation is pending. Do not submit again.'
            : 'Payment sent successfully.')
      );
      setFormData((prev) => ({ ...prev, ...EMPTY_PAYMENT }));
      // Reflect the new balance in the account picker.
      apiClient
        .get('/api/accounts')
        .then((res) => setAccounts(res.data || []))
        .catch(() => {});
      if (!pending) {
        setTimeout(() => setSuccess(''), 4000);
      }
    } catch (err) {
      if (err.response?.data?.witness_status) {
        setWitnessPending(true);
        setWitnessEventId(err.response.data.witness_event_id || '');
        setSuccess(
          `${err.response.data.error || err.response.data.message || 'Payment outcome is uncertain.'} Do not retry blindly.`
        );
        return;
      }
      setError(
        err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Failed to send payment'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <Spinner label="Loading accounts…" />;
  }

  return (
    <div className="payments-page page-grid">
      <PageHeader
        eyebrow="Payments"
        title="Send to an external IBAN"
        subtitle="Outgoing payments are witnessed exactly like internal transfers."
      />
      {error && <div className="error-message" role="alert">{error}</div>}
      {success && (
        <div className={witnessPending ? 'pending-message' : 'success-message'} role="status">
          {success}
          {witnessPending && witnessEventId && <div className="mono">Witness event: {witnessEventId}</div>}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="empty-state">
          <p>You need at least one account before sending payments.</p>
        </div>
      ) : (
        <div className="form-card">
          <form onSubmit={handleSubmit}>
            <div className="form-group full">
              <label htmlFor="from_account_id">From account</label>
              <select
                id="from_account_id"
                name="from_account_id"
                value={formData.from_account_id}
                onChange={handleChange}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.account_type.toUpperCase()} · {account.account_number} —{' '}
                    {formatCurrency(account.balance)}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="recipient_name">Recipient name</label>
              <input
                type="text"
                id="recipient_name"
                name="recipient_name"
                autoComplete="name"
                value={formData.recipient_name}
                onChange={handleChange}
                minLength={2}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="recipient_iban">Recipient IBAN</label>
              <input
                type="text"
                id="recipient_iban"
                name="recipient_iban"
                className="mono"
                spellCheck={false}
                autoCapitalize="characters"
                placeholder="DE89 3704 0044 0532 0130 00"
                value={formData.recipient_iban}
                onChange={handleChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="amount">Amount</label>
              <input
                type="number"
                id="amount"
                name="amount"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={formData.amount}
                onChange={handleChange}
                aria-invalid={insufficient || undefined}
                required
              />
              {sourceAccount && (
                <small className={insufficient ? 'field-error' : 'muted'}>
                  {insufficient ? 'Exceeds the available balance of ' : 'Available: '}
                  {formatCurrency(sourceAccount.balance)}
                </small>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="reference">Reference (optional)</label>
              <input
                type="text"
                id="reference"
                name="reference"
                maxLength={255}
                value={formData.reference}
                onChange={handleChange}
              />
            </div>

            <button type="submit" className="btn-primary full" disabled={submitting || insufficient}>
              {submitting
                ? 'Sending…'
                : Number.isFinite(amountValue) && amountValue > 0
                  ? `Send ${formatCurrency(amountValue)}`
                  : 'Send payment'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

export default Payments;
