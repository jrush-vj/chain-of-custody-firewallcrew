import React, { useEffect, useState } from 'react';
import apiClient from '../../lib/apiClient';
import './Bills.css';

const frequencyOptions = [
  { value: 'once', label: 'One time' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Bi-weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' }
];

const Bills = () => {
  const [accounts, setAccounts] = useState([]);
  const [scheduled, setScheduled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [formData, setFormData] = useState({
    account_id: '',
    payee_name: '',
    payee_iban: '',
    amount: '',
    frequency: 'monthly',
    start_date: '',
    notes: ''
  });
  const [creating, setCreating] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);
      const [accountsRes, scheduledRes] = await Promise.all([
        apiClient.get('/api/accounts'),
        apiClient.get('/api/scheduled-payments')
      ]);
      setAccounts(accountsRes.data);
      setScheduled(scheduledRes.data || []);
      if (accountsRes.data.length && !formData.account_id) {
        setFormData((prev) => ({ ...prev, account_id: accountsRes.data[0].id }));
      }
    } catch (err) {
      setError('Failed to load scheduled payments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setCreating(true);
    setError('');

    try {
      const { data } = await apiClient.post('/api/scheduled-payments', formData);
      setScheduled([data, ...scheduled]);
      setSuccess('Scheduled payment saved.');
      setFormData((prev) => ({
        ...prev,
        payee_name: '',
        payee_iban: '',
        amount: '',
        start_date: '',
        notes: ''
      }));
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create scheduled payment');
    } finally {
      setCreating(false);
    }
  };

  const cancelPayment = async (id) => {
    try {
      await apiClient.delete(`/api/scheduled-payments/${id}`);
      setScheduled(scheduled.filter((item) => item.id !== id));
    } catch (err) {
      setError('Failed to cancel payment');
    }
  };

  if (loading) {
    return <div className="loading">Loading scheduled payments...</div>;
  }

  return (
    <div className="bills-page">
      <div className="page-header">
        <h1>Orders & Bills</h1>
      </div>
      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      {accounts.length === 0 ? (
        <div className="empty-state">
          <p>Create an account first to register future payments.</p>
        </div>
      ) : (
        <div className="form-card">
          <h2>Schedule a Payment</h2>
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label htmlFor="account_id">Pay from</label>
              <select
                id="account_id"
                name="account_id"
                value={formData.account_id}
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
              <label htmlFor="payee_name">Payee name</label>
              <input
                type="text"
                id="payee_name"
                name="payee_name"
                value={formData.payee_name}
                onChange={handleChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="payee_iban">Payee IBAN</label>
              <input
                type="text"
                id="payee_iban"
                name="payee_iban"
                value={formData.payee_iban}
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
              <label htmlFor="frequency">Frequency</label>
              <select
                id="frequency"
                name="frequency"
                value={formData.frequency}
                onChange={handleChange}
              >
                {frequencyOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="start_date">Start date</label>
              <input
                type="date"
                id="start_date"
                name="start_date"
                value={formData.start_date}
                onChange={handleChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="notes">Notes (optional)</label>
              <textarea
                id="notes"
                name="notes"
                rows="3"
                value={formData.notes}
                onChange={handleChange}
              />
            </div>

            <button type="submit" className="btn-primary" disabled={creating}>
              {creating ? 'Saving...' : 'Save schedule'}
            </button>
          </form>
        </div>
      )}

      <div className="scheduled-list">
        <h2>Scheduled Payments</h2>
        {scheduled.length === 0 ? (
          <div className="empty-state">
            <p>No scheduled payments yet.</p>
          </div>
        ) : (
          scheduled.map((item) => (
            <div key={item.id} className="scheduled-item">
              <div>
                <h3>{item.payee_name}</h3>
                <p>
                  {item.amount} • {item.frequency} • starts {item.start_date}
                </p>
                <p>IBAN: {item.payee_iban}</p>
                {item.notes && <p>{item.notes}</p>}
              </div>
              <button className="btn-secondary" onClick={() => cancelPayment(item.id)}>
                Cancel
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default Bills;
