import React, { useState, useEffect } from 'react';
import apiClient from '../../lib/apiClient';
import { useNavigate } from 'react-router-dom';
import './TransactionForm.css';

const TransactionForm = () => {
  const [accounts, setAccounts] = useState([]);
  const [formData, setFormData] = useState({
    type: 'deposit',
    account_id: '',
    from_account_id: '',
    to_account_id: '',
    amount: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
<<<<<<< HEAD
=======
  const [witnessPending, setWitnessPending] = useState(false);
  const [witnessEventId, setWitnessEventId] = useState('');
>>>>>>> firewallcrew-publish
  const navigate = useNavigate();

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const response = await apiClient.get('/api/accounts');
        setAccounts(response.data);
      } catch (err) {
        setError('Failed to load accounts');
      }
    };

    fetchAccounts();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
<<<<<<< HEAD
=======
    setWitnessPending(false);
    setWitnessEventId('');
>>>>>>> firewallcrew-publish
    setLoading(true);

    try {
      const amount = parseFloat(formData.amount);
<<<<<<< HEAD

      if (formData.type === 'deposit') {
        await apiClient.post('/api/transactions/deposit', {
=======
      let response;

      if (formData.type === 'deposit') {
        response = await apiClient.post('/api/transactions/deposit', {
>>>>>>> firewallcrew-publish
          account_id: parseInt(formData.account_id),
          amount
        });
      } else if (formData.type === 'withdrawal') {
<<<<<<< HEAD
        await apiClient.post('/api/transactions/withdraw', {
=======
        response = await apiClient.post('/api/transactions/withdraw', {
>>>>>>> firewallcrew-publish
          account_id: parseInt(formData.account_id),
          amount
        });
      } else if (formData.type === 'transfer') {
<<<<<<< HEAD
        await apiClient.post('/api/transactions/transfer', {
=======
        response = await apiClient.post('/api/transactions/transfer', {
>>>>>>> firewallcrew-publish
          from_account_id: parseInt(formData.from_account_id),
          to_account_id: parseInt(formData.to_account_id),
          amount
        });
      }

<<<<<<< HEAD
      setSuccess(`${formData.type.charAt(0).toUpperCase() + formData.type.slice(1)} successful!`);
=======
      const pending = response?.data?.witness_status !== 'confirmed';
      setWitnessPending(pending);
      setWitnessEventId(response?.data?.witness_event_id || '');
      setSuccess(
        response?.data?.message ||
          (pending
            ? response?.data?.error || 'Witness confirmation is pending. Do not retry blindly.'
            : `${formData.type.charAt(0).toUpperCase() + formData.type.slice(1)} successful!`)
      );
>>>>>>> firewallcrew-publish
      setFormData({
        type: 'deposit',
        account_id: '',
        from_account_id: '',
        to_account_id: '',
        amount: ''
      });
<<<<<<< HEAD
      setTimeout(() => {
        navigate('/transactions');
      }, 1500);
    } catch (err) {
=======
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
>>>>>>> firewallcrew-publish
      const errorMessage =
        err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || err.message;
      setError(errorMessage || `Failed to process ${formData.type}`);
    } finally {
      setLoading(false);
    }
  };

  const handleTypeChange = (e) => {
    const type = e.target.value;
    setFormData({
      type,
      account_id: '',
      from_account_id: '',
      to_account_id: '',
      amount: ''
    });
  };

  return (
    <div className="transaction-form-page page-grid">
      <header className="transactions-header">
        <div>
          <p className="eyebrow">New Transaction</p>
          <h1>Execute a secure movement</h1>
          <p className="subtitle">
            Move funds between your accounts, inject capital, or withdraw safely from any ledger.
          </p>
        </div>
      </header>

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

      <section className="panel form-card">
        <form onSubmit={handleSubmit} className="transaction-form">
          <label>
            <span>Transaction type</span>
            <select id="type" value={formData.type} onChange={handleTypeChange} required>
              <option value="deposit">Deposit</option>
              <option value="withdrawal">Withdrawal</option>
              <option value="transfer">Transfer</option>
            </select>
          </label>

          {formData.type === 'deposit' && (
            <label>
              <span>Destination account</span>
              <select
                id="account_id"
                value={formData.account_id}
                onChange={(e) => setFormData({ ...formData, account_id: e.target.value })}
                required
              >
                <option value="">Select account</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.account_number} · ${parseFloat(acc.balance).toFixed(2)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {formData.type === 'withdrawal' && (
            <label>
              <span>Source account</span>
              <select
                id="account_id"
                value={formData.account_id}
                onChange={(e) => setFormData({ ...formData, account_id: e.target.value })}
                required
              >
                <option value="">Select account</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.account_number} · ${parseFloat(acc.balance).toFixed(2)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {formData.type === 'transfer' && (
            <div className="transfer-grid">
              <label>
                <span>From account</span>
                <select
                  id="from_account_id"
                  value={formData.from_account_id}
                  onChange={(e) => setFormData({ ...formData, from_account_id: e.target.value })}
                  required
                >
                  <option value="">Select account</option>
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.account_number} · ${parseFloat(acc.balance).toFixed(2)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>To account</span>
                <select
                  id="to_account_id"
                  value={formData.to_account_id}
                  onChange={(e) => setFormData({ ...formData, to_account_id: e.target.value })}
                  required
                >
                  <option value="">Select account</option>
                  {accounts
                    .filter((acc) => acc.id !== parseInt(formData.from_account_id, 10))
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.account_number} · ${parseFloat(acc.balance).toFixed(2)}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          )}

          <label>
            <span>Amount</span>
            <input
              type="number"
              id="amount"
              step="0.01"
              min="0.01"
              value={formData.amount}
              onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
              required
              placeholder="0.00"
            />
          </label>

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Processing…' : `Finalize ${formData.type}`}
          </button>
        </form>
      </section>
    </div>
  );
};

export default TransactionForm;
