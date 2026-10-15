import React, { useEffect, useState } from 'react';
import apiClient from '../../lib/apiClient';
import './Payments.css';

const Payments = () => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
<<<<<<< HEAD
=======
  const [witnessPending, setWitnessPending] = useState(false);
  const [witnessEventId, setWitnessEventId] = useState('');
>>>>>>> firewallcrew-publish
  const [formData, setFormData] = useState({
    from_account_id: '',
    recipient_name: '',
    recipient_iban: '',
    amount: '',
    reference: ''
  });

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

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setSuccess('');
<<<<<<< HEAD

    try {
      await apiClient.post('/api/transactions/external/outgoing', {
        ...formData,
        amount: parseFloat(formData.amount)
      });
      setSuccess('Payment sent successfully.');
=======
    setWitnessPending(false);
    setWitnessEventId('');

    try {
      const response = await apiClient.post('/api/transactions/external/outgoing', {
        ...formData,
        amount: parseFloat(formData.amount)
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
>>>>>>> firewallcrew-publish
      setFormData((prev) => ({
        ...prev,
        recipient_name: '',
        recipient_iban: '',
        amount: '',
        reference: ''
      }));
<<<<<<< HEAD
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
=======
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
>>>>>>> firewallcrew-publish
      setError(err.response?.data?.error || 'Failed to send payment');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="loading">Loading accounts...</div>;
  }

  return (
    <div className="payments-page">
      <div className="page-header">
        <h1>External Payments</h1>
      </div>
      {error && <div className="error-message">{error}</div>}
<<<<<<< HEAD
      {success && <div className="success-message">{success}</div>}
=======
      {success && (
        <div className={witnessPending ? 'pending-message' : 'success-message'}>
          {success}
          {witnessPending && witnessEventId && <div>Witness event: {witnessEventId}</div>}
        </div>
      )}
>>>>>>> firewallcrew-publish

      {accounts.length === 0 ? (
        <div className="empty-state">
          <p>You need at least one account before sending payments.</p>
        </div>
      ) : (
        <div className="form-card">
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="from_account_id">From Account</label>
              <select
                id="from_account_id"
                name="from_account_id"
                value={formData.from_account_id}
                onChange={handleChange}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.account_number} — ${parseFloat(account.balance).toFixed(2)}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="recipient_name">Recipient Name</label>
              <input
                type="text"
                id="recipient_name"
                name="recipient_name"
                value={formData.recipient_name}
                onChange={handleChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="recipient_iban">Recipient IBAN</label>
              <input
                type="text"
                id="recipient_iban"
                name="recipient_iban"
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
                min="0"
                step="0.01"
                value={formData.amount}
                onChange={handleChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="reference">Reference (optional)</label>
              <input
                type="text"
                id="reference"
                name="reference"
                value={formData.reference}
                onChange={handleChange}
              />
            </div>

            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Sending...' : 'Send Payment'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

export default Payments;
