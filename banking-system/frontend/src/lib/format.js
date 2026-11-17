const currencyFormatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

export const formatCurrency = (value) => currencyFormatter.format(Number(value) || 0);

export const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '—';

export const TRANSACTION_TYPES = [
  { value: 'deposit', label: 'Deposit' },
  { value: 'withdrawal', label: 'Withdrawal' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'external_incoming', label: 'Incoming payment' },
  { value: 'external_outgoing', label: 'Outgoing payment' }
];

export const typeLabel = (type) =>
  TRANSACTION_TYPES.find((item) => item.value === type)?.label || type;

// Whether a transaction added money to, removed it from, or moved it between the user's accounts.
export const directionFor = (transaction, ownAccountIds) => {
  const fromOwn = ownAccountIds.has(transaction.from_account_id);
  const toOwn = ownAccountIds.has(transaction.to_account_id);
  if (fromOwn && toOwn) return 'internal';
  if (toOwn) return 'in';
  if (fromOwn) return 'out';
  return 'internal';
};

export const signedAmount = (transaction, ownAccountIds) => {
  const amount = parseFloat(transaction.amount || 0);
  const direction = directionFor(transaction, ownAccountIds);
  return direction === 'out' ? -amount : direction === 'in' ? amount : 0;
};

export const toCsv = (rows) =>
  rows
    .map((row) =>
      row
        .map((cell) => {
          const text = cell === null || cell === undefined ? '' : String(cell);
          // Neutralise spreadsheet formula injection and quote every field.
          const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
          return `"${safe.replace(/"/g, '""')}"`;
        })
        .join(',')
    )
    .join('\r\n');

export const downloadText = (filename, text, type = 'text/csv;charset=utf-8') => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
