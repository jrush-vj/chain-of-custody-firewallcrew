import React, { useState, useEffect, useCallback, useMemo } from 'react';
import apiClient from '../../lib/apiClient';
import {
  TRANSACTION_TYPES,
  directionFor,
  downloadText,
  formatCurrency,
  formatDateTime,
  toCsv,
  typeLabel
} from '../../lib/format';
import { PageHeader, Spinner, WitnessBadge } from '../Common/Common';
import './Transactions.css';

const EMPTY_FILTERS = { type: '', startDate: '', endDate: '' };

const Transactions = () => {
  const [transactions, setTransactions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  useEffect(() => {
    apiClient
      .get('/api/accounts')
      .then((response) => setAccounts(response.data || []))
      .catch(() => setAccounts([]));
  }, []);

  const ownIds = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts]);

  const fetchTransactions = useCallback(async () => {
    try {
      setLoading(true);
      const params = {
        page: pagination.page,
        limit: pagination.limit,
        ...(filters.type && { type: filters.type }),
        ...(filters.startDate && { startDate: filters.startDate }),
        // Make the end date inclusive of the whole day.
        ...(filters.endDate && { endDate: `${filters.endDate}T23:59:59.999` })
      };

      const response = await apiClient.get('/api/transactions', { params });
      setTransactions(response.data.transactions || []);
      setPagination((prev) => response.data.pagination || prev);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load transactions');
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
    setFilters((prev) => ({ ...prev, [name]: value }));
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handlePageChange = (newPage) => {
    setPagination((prev) => ({ ...prev, page: newPage }));
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const exportCsv = () => {
    const header = ['ID', 'Type', 'Amount', 'Direction', 'From', 'To', 'Reference', 'Date', 'Status', 'Witness'];
    const rows = transactions.map((t) => [
      t.id,
      typeLabel(t.type),
      parseFloat(t.amount).toFixed(2),
      directionFor(t, ownIds),
      t.from_display || '',
      t.to_display || '',
      t.reference || '',
      new Date(t.timestamp).toISOString(),
      t.status,
      t.witness_status || 'not witnessed'
    ]);
    downloadText(`transactions-page-${pagination.page}.csv`, toCsv([header, ...rows]));
  };

  const hasFilters = filters.type || filters.startDate || filters.endDate;

  if (loading && transactions.length === 0) {
    return <Spinner label="Loading transactions…" />;
  }

  return (
    <div className="transactions-page page-grid">
      <PageHeader
        eyebrow="Transactions"
        title="Activity log"
        subtitle="Filter and audit every movement. The witness column shows whether the independent witness has sealed each entry."
      >
        <button
          type="button"
          className="ghost-button"
          onClick={exportCsv}
          disabled={!transactions.length}
        >
          Export CSV
        </button>
      </PageHeader>

      {error && <div className="error-message">{error}</div>}

      <section className="panel filters-panel">
        <div className="filters-grid">
          <label>
            <span>Type</span>
            <select id="type" name="type" value={filters.type} onChange={handleFilterChange}>
              <option value="">All types</option>
              {TRANSACTION_TYPES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>From</span>
            <input
              type="date"
              id="startDate"
              name="startDate"
              value={filters.startDate}
              max={filters.endDate || undefined}
              onChange={handleFilterChange}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              id="endDate"
              name="endDate"
              value={filters.endDate}
              min={filters.startDate || undefined}
              onChange={handleFilterChange}
            />
          </label>
          <button onClick={clearFilters} className="ghost-button clear-btn" disabled={!hasFilters}>
            Clear filters
          </button>
        </div>
      </section>

      {transactions.length === 0 ? (
        <div className="empty-state">
          {hasFilters ? 'No transactions match these filters.' : 'No transactions yet.'}
        </div>
      ) : (
        <section className={`panel${loading ? ' is-loading' : ''}`}>
          <div className="transactions-table-container">
            <table className="transactions-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th className="num">Amount</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Reference</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Witness</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((transaction) => {
                  const direction = directionFor(transaction, ownIds);
                  return (
                    <tr key={transaction.id}>
                      <td className="muted">#{transaction.id}</td>
                      <td>
                        <span className={`transaction-type ${transaction.type}`}>
                          {typeLabel(transaction.type)}
                        </span>
                      </td>
                      <td className={`amount num ${direction}`}>
                        {direction === 'in' ? '+' : direction === 'out' ? '−' : ''}
                        {formatCurrency(transaction.amount)}
                      </td>
                      <td className="mono">{transaction.from_display || '—'}</td>
                      <td className="mono">{transaction.to_display || '—'}</td>
                      <td className="description" title={transaction.reference || ''}>
                        {transaction.reference || '—'}
                      </td>
                      <td>{formatDateTime(transaction.timestamp)}</td>
                      <td>
                        <span className={`status ${transaction.status}`}>{transaction.status}</span>
                      </td>
                      <td>
                        <WitnessBadge status={transaction.witness_status} compact />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pagination.pages > 1 && (
            <div className="pagination">
              <button
                onClick={() => handlePageChange(pagination.page - 1)}
                disabled={pagination.page === 1 || loading}
                className="ghost-button"
              >
                Previous
              </button>
              <span>
                Page {pagination.page} of {pagination.pages} · {pagination.total} total
              </span>
              <button
                onClick={() => handlePageChange(pagination.page + 1)}
                disabled={pagination.page >= pagination.pages || loading}
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
