import React, { useEffect, useMemo, useState } from 'react';
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
import './Dashboard.css';

const COLORS = ['#5ad8ff', '#5ad3a2', '#f6c343', '#ff8ba7', '#a48bff'];

const formatCurrency = (value) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);

const Dashboard = () => {
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [accountsRes, transactionsRes] = await Promise.all([
          apiClient.get('/api/accounts'),
          apiClient.get('/api/transactions?limit=25')
        ]);
        setAccounts(accountsRes.data || []);
        setTransactions(transactionsRes.data.transactions || []);
        setError('');
      } catch (err) {
        console.error(err);
        setError('Unable to load dashboard data.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  const totalBalance = useMemo(
    () =>
      accounts.reduce((sum, account) => sum + parseFloat(account.balance || 0), 0).toFixed(2),
    [accounts]
  );

  const netTransactions = useMemo(() => {
    const balances = [];
    let running = Number(totalBalance);
    transactions
      .slice(0, 8)
      .forEach((transaction) => {
        balances.push({
          label: new Date(transaction.timestamp).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric'
          }),
          balance: running
        });
        const delta = transaction.to_account_number ? parseFloat(transaction.amount) : 0;
        running -= delta;
      });
    balances.push({ label: 'Earlier', balance: Math.max(running, 0) });
    return balances.reverse();
  }, [transactions, totalBalance]);

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
      ['deposit', 'withdrawal', 'transfer'].map((type) => ({
        type,
        total: Number(
          transactions
            .filter((transaction) => transaction.type === type)
            .reduce((acc, transaction) => acc + Math.abs(parseFloat(transaction.amount || 0)), 0)
            .toFixed(2)
        )
      })),
    [transactions]
  );

  const topAccount = useMemo(() => {
    if (!accounts.length) return null;
    return [...accounts].sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))[0];
  }, [accounts]);

  if (loading) {
    return <div className="loading">Preparing your personalized cockpit…</div>;
  }

  return (
    <div className="dashboard page-grid">
      {error && <div className="error-message">{error}</div>}

      <section className="summary-grid">
        <article className="summary-card">
          <p>Total balance</p>
          <h2>{formatCurrency(Number(totalBalance))}</h2>
          <span>Across {accounts.length} accounts</span>
        </article>
        <article className="summary-card">
          <p>Top performing account</p>
          {topAccount ? (
            <>
              <h2>{formatCurrency(parseFloat(topAccount.balance || 0))}</h2>
              <span>
                {topAccount.account_type.toUpperCase()} · {topAccount.account_number}
              </span>
            </>
          ) : (
            <span>Open an account to get started</span>
          )}
        </article>
        <article className="summary-card">
          <p>Recent activity</p>
          <h2>{transactions.length}</h2>
          <span>Last 30 entries</span>
        </article>
      </section>

      <section className="charts-grid">
        <article className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h3>Net worth timeline</h3>
              <p>Balance trend derived from recent entries</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={netTransactions}>
              <defs>
                <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#5ad8ff" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#5ad8ff" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" />
              <YAxis stroke="rgba(255,255,255,0.45)" tickFormatter={formatCurrency} />
              <Tooltip
                contentStyle={{ background: '#0b1320', border: '1px solid rgba(255,255,255,0.08)' }}
                formatter={(value) => formatCurrency(value)}
              />
              <Area type="monotone" dataKey="balance" stroke="#5ad8ff" fill="url(#balanceGradient)" />
            </AreaChart>
          </ResponsiveContainer>
        </article>

        <article className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h3>Account mix</h3>
              <p>Real-time split of balances</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={accountDistribution}
                innerRadius={60}
                outerRadius={90}
                paddingAngle={6}
                dataKey="value"
              >
                {accountDistribution.map((entry, index) => (
                  <Cell key={`cell-${entry.name}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: '#0b1320', border: '1px solid rgba(255,255,255,0.08)' }}
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
        </article>

        <article className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h3>Movement intensity</h3>
              <p>Volume per transaction type</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={activityByType}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis
                dataKey="type"
                stroke="rgba(255,255,255,0.45)"
                tickFormatter={(value) => value.charAt(0).toUpperCase() + value.slice(1)}
              />
              <YAxis stroke="rgba(255,255,255,0.45)" tickFormatter={formatCurrency} />
              <Tooltip
                contentStyle={{ background: '#0b1320', border: '1px solid rgba(255,255,255,0.08)' }}
                formatter={(value) => formatCurrency(value)}
              />
              <Bar dataKey="total" radius={[12, 12, 0, 0]} fill="#5ad3a2" />
            </BarChart>
          </ResponsiveContainer>
        </article>
      </section>

      <section className="panel accounts-panel">
        <div className="panel-header">
          <div>
            <h3>Your accounts</h3>
            <p>IBAN-ready ledgers with real-time settlement</p>
          </div>
        </div>
        {accounts.length === 0 ? (
          <div className="empty-state">No accounts yet. Create one from the Accounts module.</div>
        ) : (
          <div className="accounts-grid">
            {accounts.map((account) => (
              <article key={account.id} className="account-card">
                <header>
                  <span>{account.account_type}</span>
                  <strong>{formatCurrency(parseFloat(account.balance || 0))}</strong>
                </header>
                <p>Account: {account.account_number}</p>
                {account.iban && <p>IBAN: {account.iban}</p>}
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
        </div>
        {transactions.length === 0 ? (
          <div className="empty-state">No transactions yet.</div>
        ) : (
          <div className="transactions-table">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Description</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {transactions.slice(0, 10).map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{transaction.id}</td>
                    <td>
                      <span className={`tag ${transaction.type}`}>{transaction.type}</span>
                    </td>
                    <td>{formatCurrency(parseFloat(transaction.amount || 0))}</td>
                    <td>{transaction.from_account_number || '—'}</td>
                    <td>{transaction.to_account_number || '—'}</td>
                    <td className="description-cell">{transaction.description || '—'}</td>
                    <td>{new Date(transaction.timestamp).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default Dashboard;
