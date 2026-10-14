import React, { useState, useEffect, useCallback } from 'react';
import apiClient from '../../lib/apiClient';
import './Transactions.css';

const Transactions = () => {
  const [transactions, setTransactions] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    type: '',
    startDate: '',
    endDate: ''
  });

  const fetchTransactions = useCallback(async () => {
    try {
      setLoading(true);
      const params = {
        page: pagination.page,
        limit: pagination.limit,
        ...(filters.type && { type: filters.type }),
        ...(filters.startDate && { startDate: filters.startDate }),
        ...(filters.endDate && { endDate: filters.endDate })
      };

      const response = await apiClient.get('/api/transactions', { params });
      setTransactions(response.data.transactions || []);
      setPagination((prev) => response.data.pagination || prev);
      setError('');
    } catch (err) {
      setError('Failed to load transactions');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, filters.type, filters.startDate, filters.endDate]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const handleFilterChange = (event) => {
    const { name, value } = event.target;
    setFilters({ ...filters, [name]: value });
    setPagination({ ...pagination, page: 1 });
  };

  const handlePageChange = (newPage) => {
    setPagination({ ...pagination, page: newPage });
  };

  const clearFilters = () => {
    setFilters({ type: '', startDate: '', endDate: '' });
    setPagination({ ...pagination, page: 1 });
  };

  if (loading && transactions.length === 0) {
    return <div className="loading">Loading transactions...</div>;
  }

  return (
    <div className="transactions-page page-grid">
      <header className="transactions-header">
        <div>
          <p className="eyebrow">Transactions</p>
          <h1>Comprehensive activity log</h1>
          <p className="subtitle">
            Filter and audit every deposit, withdrawal, or transfer completed through your accounts.
          </p>
        </div>
      </header>

      {error && <div className="error-message">{error}</div>}

      <section className="panel filters-panel">
        <h2>Filters</h2>
        <div className="filters-grid">
          <label>
            <span>Type</span>
            <select id="type" name="type" value={filters.type} onChange={handleFilterChange}>
              <option value="">All</option>
              <option value="deposit">Deposit</option>
              <option value="withdrawal">Withdrawal</option>
              <option value="transfer">Transfer</option>
            </select>
          </label>
          <label>
            <span>Start date</span>
            <input
              type="date"
              id="startDate"
              name="startDate"
              value={filters.startDate}
              onChange={handleFilterChange}
            />
          </label>
          <label>
            <span>End date</span>
            <input
              type="date"
              id="endDate"
              name="endDate"
              value={filters.endDate}
              onChange={handleFilterChange}
            />
          </label>
          <button onClick={clearFilters} className="ghost-button clear-btn">
            Clear filters
          </button>
        </div>
      </section>

      {transactions.length === 0 ? (
        <div className="empty-state">No transactions found.</div>
      ) : (
        <section className="panel">
          <div className="transactions-table-container">
            <table className="transactions-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Description</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{transaction.id}</td>
                    <td>
                      <span className={`transaction-type ${transaction.type}`}>
                        {transaction.type}
                      </span>
                    </td>
                    <td className="amount">${parseFloat(transaction.amount).toFixed(2)}</td>
                    <td>{transaction.from_display || '—'}</td>
                    <td>{transaction.to_display || '—'}</td>
                    <td className="description">
                      {transaction.reference || transaction.description || '—'}
                    </td>
                    <td>{new Date(transaction.timestamp).toLocaleString()}</td>
                    <td>
                      <span className={`status ${transaction.status}`}>{transaction.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pagination.pages > 1 && (
            <div className="pagination">
              <button
                onClick={() => handlePageChange(pagination.page - 1)}
                disabled={pagination.page === 1}
                className="ghost-button"
              >
                Previous
              </button>
              <span>
                Page {pagination.page} of {pagination.pages} (Total: {pagination.total})
              </span>
              <button
                onClick={() => handlePageChange(pagination.page + 1)}
                disabled={pagination.page >= pagination.pages}
                className="ghost-button"
              >
                Next
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default Transactions;
