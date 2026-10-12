import express from 'express';
import { Account } from '../models/Account.js';
import { Transaction } from '../models/Transaction.js';

const router = express.Router();

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const buildViewModel = (overrides = {}) => ({
  form: {
    senderName: '',
    senderEmail: '',
    iban: '',
    amount: '',
    reference: '',
    ...overrides.form
  },
  errors: overrides.errors || [],
  success: overrides.success || null,
  recentAccount: overrides.recentAccount || null
});

const renderTemplate = (model) => {
  const { form, errors, success, recentAccount } = model;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Send Payment | Banking System</title>
    <style>
      :root {
        font-family: 'Inter', 'Segoe UI', sans-serif;
        color: #fff;
        background: #050914;
      }
      body {
        min-height: 100vh;
        margin: 0;
        padding: 2rem;
        background: radial-gradient(circle at top, #131b36, #04040a 70%);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .portal {
        width: min(960px, 100%);
        background: rgba(14, 20, 42, 0.95);
        border-radius: 24px;
        padding: 2.5rem;
        box-shadow: 0 40px 90px rgba(0, 0, 0, 0.5);
      }
      .portal header {
        margin-bottom: 1rem;
      }
      .portal h1 {
        margin: 0;
        font-size: clamp(2rem, 3vw, 2.6rem);
      }
      .portal .lead {
        color: rgba(255, 255, 255, 0.65);
        margin-top: 0.5rem;
      }
      .portal form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 1rem;
        margin-top: 1.5rem;
      }
      label {
        display: flex;
        flex-direction: column;
        color: rgba(255, 255, 255, 0.8);
        gap: 0.35rem;
      }
      input,
      textarea,
      select {
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        padding: 0.85rem 1rem;
        font-size: 1rem;
        background: rgba(255, 255, 255, 0.03);
        color: #fff;
      }
      textarea {
        min-height: 110px;
        resize: vertical;
      }
      .actions {
        grid-column: 1 / -1;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
      }
      button {
        border: none;
        border-radius: 999px;
        padding: 0.9rem 2.5rem;
        font-size: 1rem;
        font-weight: 600;
        color: #030712;
        background: linear-gradient(120deg, #5ad8ff, #5ad3a2);
        cursor: pointer;
        transition: transform 0.2s;
      }
      button:hover {
        transform: translateY(-1px);
      }
      .alert {
        margin-top: 1rem;
        padding: 0.85rem 1rem;
        border-radius: 16px;
      }
      .alert.error {
        background: rgba(255, 107, 129, 0.15);
        border: 1px solid rgba(255, 107, 129, 0.45);
        color: #ffd7dd;
      }
      .alert.success {
        background: rgba(90, 211, 162, 0.15);
        border: 1px solid rgba(90, 211, 162, 0.45);
        color: #d1fff2;
      }
      .recent {
        margin-top: 1.5rem;
        padding: 1.25rem;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .recent dl {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 0.75rem;
        margin: 0;
      }
      .recent dt {
        font-size: 0.7rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.6);
      }
      .recent dd {
        margin: 0.2rem 0 0;
        font-size: 1.05rem;
      }
      @media (max-width: 640px) {
        .actions {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <section class="portal">
      <header>
        <h1>External payment portal</h1>
        <p class="lead">Send funds securely to any IBAN managed inside this banking system.</p>
      </header>
      ${errors.length ? `<div class="alert error">${errors.join('<br/>')}</div>` : ''}
      ${success ? `<div class="alert success">${escapeHtml(success)}</div>` : ''}
      <form method="POST" novalidate>
        <label>
          Sender full name
          <input name="senderName" value="${escapeHtml(form.senderName)}" required placeholder="Jane Financial" />
        </label>
        <label>
          Contact email
          <input type="email" name="senderEmail" value="${escapeHtml(form.senderEmail)}" required placeholder="sender@example.com" />
        </label>
        <label>
          Destination IBAN
          <input name="iban" value="${escapeHtml(form.iban)}" required placeholder="DE89 3704 0044 0532 0130 00" />
        </label>
        <label>
          Amount
          <input name="amount" value="${escapeHtml(form.amount)}" required type="number" step="0.01" min="0.01" />
        </label>
        <label class="full-width">
          Payment reference
          <textarea name="reference" placeholder="Optional note to the recipient">${escapeHtml(form.reference)}</textarea>
        </label>
        <div class="actions">
          <button type="submit">Send payment</button>
          <p style="margin:0;color:rgba(255,255,255,0.6);">Payments credit instantly upon confirmation.</p>
        </div>
      </form>
      ${
        recentAccount
          ? `<div class="recent">
              <strong>Latest transfer</strong>
              <dl>
                <div>
                  <dt>IBAN</dt>
                  <dd>${escapeHtml(recentAccount.iban)}</dd>
                </div>
                <div>
                  <dt>Account</dt>
                  <dd>${escapeHtml(recentAccount.account_number)}</dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>$${escapeHtml(recentAccount.amount)}</dd>
                </div>
                <div>
                  <dt>New balance</dt>
                  <dd>$${escapeHtml(recentAccount.balance)}</dd>
                </div>
              </dl>
            </div>`
          : ''
      }
    </section>
  </body>
</html>`;
};

router.get('/', (req, res) => {
  res.type('html').send(renderTemplate(buildViewModel()));
});

router.post('/', async (req, res) => {
  const { senderName, senderEmail, iban, amount, reference } = req.body || {};
  const errors = [];

  const trimmedName = senderName?.trim();
  const trimmedEmail = senderEmail?.trim();
  const normalizedIban = iban?.replace(/\s+/g, '').toUpperCase();
  const amountValue = parseFloat(amount);

  if (!trimmedName) {
    errors.push('Sender name is required.');
  }

  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    errors.push('A valid contact email is required.');
  }

  if (!normalizedIban) {
    errors.push('Destination IBAN is required.');
  }

  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    errors.push('Amount must be greater than 0.');
  }

  let destinationAccount = null;
  if (!errors.length && normalizedIban) {
    destinationAccount = await Account.findByIban(normalizedIban);
    if (!destinationAccount) {
      errors.push('No account with the provided IBAN exists in the system.');
    }
  }

  if (errors.length) {
    return res
      .status(400)
      .type('html')
      .send(
        renderTemplate(
          buildViewModel({
            errors,
            form: { senderName, senderEmail, iban, amount, reference }
          })
        )
      );
  }

  const newBalance = parseFloat(destinationAccount.balance) + amountValue;
  await Account.updateBalance(destinationAccount.id, newBalance);

  const descriptors = [
    `External payment from ${trimmedName}`,
    trimmedEmail ? `Sender: ${trimmedEmail}` : null,
    reference?.trim() ? `Reference: ${reference.trim()}` : null
  ].filter(Boolean);

  await Transaction.create(
    null,
    destinationAccount.id,
    amountValue,
    'deposit',
    'completed',
    {
      reference: descriptors.join(' | ') || 'External payment portal'
    }
  );

  res
    .status(200)
    .type('html')
    .send(
      renderTemplate(
        buildViewModel({
          success: 'Payment posted! Funds are now available to the account owner.',
          recentAccount: {
            iban: destinationAccount.iban,
            account_number: destinationAccount.account_number,
            amount: amountValue.toFixed(2),
            balance: newBalance.toFixed(2)
          }
        })
      )
    );
});

export default router;
