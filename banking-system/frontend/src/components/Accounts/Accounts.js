import React, { useCallback, useEffect, useMemo, useState } from 'react';
import apiClient from '../../lib/apiClient';
import './Accounts.css';

const Accounts = () => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ account_type: 'checking' });
  const [modalState, setModalState] = useState(null);
  const [modalMessage, setModalMessage] = useState('');
  const [modalLoading, setModalLoading] = useState(false);

  const fetchAccounts = useCallback(async () => {
    try {
      setLoading(true);
      const response = await apiClient.get('/api/accounts');
      setAccounts(response.data || []);
      setError('');
    } catch (err) {
      console.error(err);
      setError('Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const announceSuccess = useCallback((message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  }, []);

  const totalBalance = useMemo(
    () => accounts.reduce((sum, acc) => sum + parseFloat(acc.balance || 0), 0),
    [accounts]
  );

  const handleCreateAccount = async (event) => {
    event.preventDefault();
    try {
      const response = await apiClient.post('/api/accounts', formData);
      setAccounts((prev) => [response.data, ...prev]);
      announceSuccess('Account created successfully.');
      setShowForm(false);
      setFormData({ account_type: 'checking' });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create account');
    }
  };

  const openDeleteModal = (account) => {
    setModalState({
      account,
      stage: parseFloat(account.balance) > 0 ? 'transfer' : 'confirm',
      transferAccountId: ''
    });
    setModalMessage('');
  };

  const closeModal = () => {
    setModalState(null);
    setModalMessage('');
    setModalLoading(false);
  };

  const handleTransferAndDelete = async () => {
    if (!modalState?.account) return;
    if (!modalState.transferAccountId) {
      setModalMessage('Select a destination account before transferring funds.');
      return;
    }

    setModalLoading(true);
    setModalMessage('');
    try {
      await apiClient.post('/api/transactions/transfer', {
        from_account_id: modalState.account.id,
        to_account_id: Number(modalState.transferAccountId),
        amount: parseFloat(modalState.account.balance)
      });
      await fetchAccounts();
      setModalState((prev) => ({
        ...prev,
        stage: 'confirm',
        account: { ...prev.account, balance: 0 }
      }));
      setModalMessage('Balance transferred. You can now delete the account.');
    } catch (err) {
      setModalMessage(err.response?.data?.error || 'Unable to transfer remaining funds.');
    } finally {
      setModalLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!modalState?.account) return;
    setModalLoading(true);
    setModalMessage('');
    try {
      await apiClient.delete(`/api/accounts/${modalState.account.id}`);
      setAccounts((prev) => prev.filter((acc) => acc.id !== modalState.account.id));
      announceSuccess('Account deleted successfully.');
      closeModal();
    } catch (err) {
      setModalMessage(err.response?.data?.error || 'Failed to delete account.');
    } finally {
      setModalLoading(false);
    }
  };

  const availableTargets = useMemo(() => {
    if (!modalState?.account) return [];
    return accounts.filter((acc) => acc.id !== modalState.account.id);
  }, [accounts, modalState]);

  if (loading) {
    return <div className="loading">Loading account portfolio…</div>;
  }

  return (
    <div className="accounts-page page-grid">
      <header className="accounts-header">
        <div>
          <p className="eyebrow">Accounts Overview</p>
          <h1>Your IBAN-ready accounts</h1>
          <p className="subtitle">
            Manage multi-product balances, issue new ledgers, and retire unused accounts with a
            single click.
          </p>
        </div>
        <div className="header-actions">
          <div className="stat">
            <span>Total balance</span>
            <strong>${totalBalance.toFixed(2)}</strong>
          </div>
          <button className="btn-primary" onClick={() => setShowForm((prev) => !prev)}>
            {showForm ? 'Close form' : 'Create account'}
          </button>
        </div>
      </header>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      {showForm && (
        <section className="panel form-panel">
          <h2>Launch a new account</h2>
          <form onSubmit={handleCreateAccount} className="inline-form">
            <label>
              <span>Account type</span>
              <select
                value={formData.account_type}
                onChange={(e) => setFormData({ account_type: e.target.value })}
              >
                <option value="checking">Checking</option>
                <option value="savings">Savings</option>
                <option value="business">Business</option>
              </select>
            </label>
            <button type="submit" className="btn-primary">
              Create
            </button>
          </form>
        </section>
      )}

      {accounts.length === 0 ? (
        <div className="empty-state">No accounts yet. Tap “Create account” to get started.</div>
      ) : (
        <section className="accounts-grid">
          {accounts.map((account) => (
            <article key={account.id} className="account-card advanced">
              <header>
                <span>{account.account_type}</span>
                <strong>${parseFloat(account.balance).toFixed(2)}</strong>
              </header>
              <p className="muted">{account.account_number}</p>
              {account.iban && <p className="muted">IBAN: {account.iban}</p>}
              <small>Opened {new Date(account.created_at).toLocaleDateString()}</small>
              <div className="card-actions">
                <button className="ghost-button" onClick={() => openDeleteModal(account)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {modalState && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>
              {modalState.stage === 'transfer'
                ? 'Move funds before deleting'
                : 'Confirm account deletion'}
            </h3>
            <p>
              Account <strong>{modalState.account.account_number}</strong> currently holds{' '}
              <strong>${parseFloat(modalState.account.balance).toFixed(2)}</strong>.
            </p>
            {modalState.stage === 'transfer' ? (
              <>
                {availableTargets.length === 0 ? (
                  <p className="muted">
                    You need at least one additional account to receive the funds.
                  </p>
                ) : (
                  <label className="floating-label">
                    <span>Select destination account</span>
                    <select
                      value={modalState.transferAccountId}
                      onChange={(e) =>
                        setModalState((prev) => ({ ...prev, transferAccountId: e.target.value }))
                      }
                    >
                      <option value="">Choose account</option>
                      {availableTargets.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.account_number} · ${parseFloat(acc.balance).toFixed(2)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="modal-actions">
                  <button className="ghost-button" onClick={closeModal}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleTransferAndDelete}
                    disabled={!availableTargets.length || modalLoading}
                  >
                    {modalLoading ? 'Moving funds…' : 'Transfer balance'}
                  </button>
                </div>
              </>
            ) : (
              <div className="modal-actions">
                <button className="ghost-button" onClick={closeModal} disabled={modalLoading}>
                  Keep account
                </button>
                <button className="btn-primary" onClick={handleConfirmDelete} disabled={modalLoading}>
                  {modalLoading ? 'Deleting…' : 'Delete account'}
                </button>
              </div>
            )}
            {modalMessage && <div className="modal-message">{modalMessage}</div>}
          </div>
        </div>
      )}
    </div>
  );
};

export default Accounts;
