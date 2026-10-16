import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Pie,
  PieChart
} from 'recharts';
import apiClient from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import {
  TRANSACTION_TYPES,
  directionFor,
  formatCurrency,
  formatDateTime,
  signedAmount,
  typeLabel
} from '../../lib/format';
import { CopyButton, Spinner, WitnessBadge } from '../Common/Common';
import './Dashboard.css';

const COLORS = ['#5ad8ff', '#5ad3a2', '#f6c343', '#ff8ba7', '#a48bff'];
const RECENT_LIMIT = 25;
const tooltipStyle = { background: '#0b1320', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 };
const compactCurrency = (value) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact' }).format(value);

const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

const Dashboard = () => {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const fetchData = useCallback(async (initial = false) => {
    try {
      if (initial) setLoading(true);
      else setRefreshing(true);
      const [accountsRes, transactionsRes] = await Promise.all([
        apiClient.get('/api/accounts'),
        apiClient.get('/api/transactions', { params: { limit: RECENT_LIMIT } })
      ]);
      setAccounts(accountsRes.data || []);
      setTransactions(transactionsRes.data.transactions || []);
      setError('');
    } catch (err) {
      console.error(err);
      setError('Unable to load dashboard data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData(true);
  }, [fetchData]);

  const ownIds = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts]);

  const totalBalance = useMemo(
    () => accounts.reduce((sum, account) => sum + parseFloat(account.balance || 0), 0),
    [accounts]
  );

  const flows = useMemo(() => {
    let moneyIn = 0;
    let moneyOut = 0;
    transactions.forEach((transaction) => {
      const amount = signedAmount(transaction, ownIds);
      if (amount > 0) moneyIn += amount;
      if (amount < 0) moneyOut -= amount;
    });
    return { moneyIn, moneyOut };
  }, [transactions, ownIds]);

  const witnessCoverage = useMemo(() => {
    if (!transactions.length) return null;
    const confirmed = transactions.filter((t) => t.witness_status === 'confirmed').length;
    const pending = transactions.filter((t) => t.witness_status === 'pending').length;
    return { confirmed, pending, percent: Math.round((confirmed / transactions.length) * 100) };
  }, [transactions]);

  // Walk backwards from today's balance, undoing each transaction's net effect on the user's total.
  const balanceTimeline = useMemo(() => {
    const points = [{ label: 'Now', balance: Number(totalBalance.toFixed(2)) }];
    let running = totalBalance;
    transactions.forEach((transaction) => {
      running -= signedAmount(transaction, ownIds);
      points.push({
        label: new Date(transaction.timestamp).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric'
        }),
        balance: Number(Math.max(running, 0).toFixed(2))
      });
    });
    return points.reverse();
  }, [transactions, totalBalance, ownIds]);

  const accountDistribution = useMemo(() => {
    const groups = {};
    accounts.forEach((account) => {
      const type = account.account_type;
      groups[type] = (groups[type] || 0) + parseFloat(account.balance || 0);
    });
    return Object.entries(groups).map(([type, value]) => ({
      name: `${type.charAt(0).toUpperCase()}${type.slice(1)}`,
      value: Number(value.toFixed(2))
    }));
  }, [accounts]);

  const activityByType = useMemo(
    () =>
      TRANSACTION_TYPES.map(({ value, label }) => ({
        type: label.replace(' payment', ''),
        total: Number(
          transactions
            .filter((transaction) => transaction.type === value)
            .reduce((acc, transaction) => acc + Math.abs(parseFloat(transaction.amount || 0)), 0)
            .toFixed(2)
        )
      })).filter((entry) => entry.total > 0),
    [transactions]
  );

  if (loading) {
    return <Spinner label="Preparing your dashboard…" />;
  }

  return (
    <div className="dashboard page-grid">
      <header className="dashboard-hero">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>
            {greeting()}, {user?.username || 'there'}
          </h1>
          <p className="subtitle">
            Every movement below is sealed and checked by an independent witness.
          </p>
        </div>
        <div className="quick-actions">
          <Link to="/transfer" className="btn-primary">
            New transaction
          </Link>
          <Link to="/payments" className="ghost-button">
            Pay someone
          </Link>
          <button
            type="button"
            className="ghost-button"
            onClick={() => fetchData(false)}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="error-message">{error}</div>}

      <section className="summary-grid">
        <article className="summary-card primary">
          <p>Total balance</p>
          <h2>{formatCurrency(totalBalance)}</h2>
          <span>
            Across {accounts.length} account{accounts.length === 1 ? '' : 's'}
          </span>
        </article>
        <article className="summary-card">
          <p>Money in</p>
          <h2 className="amount-in">+{formatCurrency(flows.moneyIn)}</h2>
          <span>Last {transactions.length} entries</span>
        </article>
        <article className="summary-card">
          <p>Money out</p>
          <h2 className="amount-out">−{formatCurrency(flows.moneyOut)}</h2>
          <span>Last {transactions.length} entries</span>
        </article>
        <article className="summary-card witness">
          <p>Witness coverage</p>
          {witnessCoverage ? (
            <>
              <h2>{witnessCoverage.percent}%</h2>
              <div
                className="coverage-bar"
                role="progressbar"
                aria-valuenow={witnessCoverage.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <i style={{ width: `${witnessCoverage.percent}%` }} />
              </div>
              <span>
                {witnessCoverage.confirmed} confirmed
                {witnessCoverage.pending ? ` · ${witnessCoverage.pending} pending` : ''}
              </span>
            </>
          ) : (
            <span>No transactions yet</span>
          )}
        </article>
      </section>

      <section className="charts-grid">
        <article className="panel chart-panel wide">
          <div className="panel-header">
            <div>
              <h3>Balance timeline</h3>
              <p>Your combined balance across recent movements</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={balanceTimeline}>
              <defs>
                <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#5ad8ff" stopOpacity={0.7} />
                  <stop offset="95%" stopColor="#5ad8ff" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" tickLine={false} />
              <YAxis
                stroke="rgba(255,255,255,0.45)"
                tickFormatter={compactCurrency}
                tickLine={false}
                width={70}
              />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatCurrency(value)} />
              <Area
                type="monotone"
                dataKey="balance"
                stroke="#5ad8ff"
                strokeWidth={2}
                fill="url(#balanceGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </article>

        <article className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h3>Account mix</h3>
              <p>How your balance is split</p>
            </div>
          </div>
          {accountDistribution.length === 0 ? (
            <div className="empty-state">Open an account to see the split.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={accountDistribution}
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={4}
                    dataKey="value"
                    stroke="none"
                  >
                    {accountDistribution.map((entry, index) => (
                      <Cell key={`cell-${entry.name}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(value, name) => [formatCurrency(value), name]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="legend">
                {accountDistribution.map((item, index) => (
                  <span key={item.name}>
                    <i style={{ background: COLORS[index % COLORS.length] }} />
                    {item.name}: {formatCurrency(item.value)}
                  </span>
                ))}
              </div>
            </>
          )}
        </article>

        <article className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h3>Volume by type</h3>
              <p>Recent totals per transaction type</p>
            </div>
          </div>
          {activityByType.length === 0 ? (
            <div className="empty-state">No activity yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={activityByType}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="type" stroke="rgba(255,255,255,0.45)" tickLine={false} />
                <YAxis
                  stroke="rgba(255,255,255,0.45)"
                  tickFormatter={compactCurrency}
                  tickLine={false}
                  width={70}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  formatter={(value) => formatCurrency(value)}
                />
                <Bar dataKey="total" radius={[10, 10, 0, 0]}>
                  {activityByType.map((entry, index) => (
                    <Cell key={entry.type} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </article>
      </section>

      <section className="panel accounts-panel">
        <div className="panel-header">
          <div>
            <h3>Your accounts</h3>
            <p>IBAN-ready ledgers with real-time settlement</p>
          </div>
          <Link to="/accounts" className="ghost-button">
            Manage
          </Link>
        </div>
        {accounts.length === 0 ? (
          <div className="empty-state">
            No accounts yet. <Link to="/accounts">Create one</Link> to get started.
          </div>
        ) : (
          <div className="accounts-grid">
            {accounts.map((account) => (
              <article key={account.id} className="account-card">
                <header>
                  <span>{account.account_type}</span>
                  <strong>{formatCurrency(account.balance)}</strong>
                </header>
                <p className="mono">{account.account_number}</p>
                {account.iban && (
                  <p className="iban-row">
                    <span className="mono">{account.iban}</span>
                    <CopyButton value={account.iban} label="Copy IBAN" />
                  </p>
                )}
                <small>Opened {new Date(account.created_at).toLocaleDateString()}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h3>Recent transactions</h3>
            <p>Latest 10 movements across your accounts</p>
          </div>
          <Link to="/transactions" className="ghost-button">
            View all
          </Link>
        </div>
        {transactions.length === 0 ? (
          <div className="empty-state">No transactions yet.</div>
        ) : (
          <div className="transactions-table">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Reference</th>
                  <th>Date</th>
                  <th>Witness</th>
                </tr>
              </thead>
              <tbody>
                {transactions.slice(0, 10).map((transaction) => {
                  const direction = directionFor(transaction, ownIds);
                  return (
                    <tr key={transaction.id}>
                      <td>
                        <span className={`tag ${transaction.type}`}>{typeLabel(transaction.type)}</span>
                      </td>
                      <td className={`amount-cell ${direction}`}>
                        {direction === 'in' ? '+' : direction === 'out' ? '−' : ''}
                        {formatCurrency(transaction.amount)}
                      </td>
                      <td className="mono">{transaction.from_display || '—'}</td>
                      <td className="mono">{transaction.to_display || '—'}</td>
                      <td className="description-cell" title={transaction.reference || ''}>
                        {transaction.reference || '—'}
                      </td>
                      <td>{formatDateTime(transaction.timestamp)}</td>
                      <td>
                        <WitnessBadge status={transaction.witness_status} compact />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default Dashboard;
