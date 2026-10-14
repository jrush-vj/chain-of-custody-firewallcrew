import { Command } from 'commander';
import inquirer from 'inquirer';
import { connectDB, closeDB } from './config/database.js';
import { createTables, dropTables } from './database/migrations.js';
import { seedDatabase } from './database/seed.js';
import { User } from './models/User.js';
import { Account } from './models/Account.js';
import { Transaction } from './models/Transaction.js';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('banking-cli')
  .description('Interactive CLI tool for banking system management')
  .version('1.0.0')
  .option('-i, --interactive', 'Launch interactive mode')
  .action(async (options) => {
    if (options.interactive || process.argv.length === 2) {
      await interactiveMode();
    } else {
      program.help();
    }
  });

// Database commands
program
  .command('migrate')
  .description('Run database migrations')
  .action(async () => {
    try {
      await connectDB();
      await createTables();
      console.log('✓ Migrations completed successfully');
      await closeDB();
    } catch (error) {
      console.error('✗ Migration failed:', error.message);
      process.exit(1);
    }
  });

program
  .command('seed')
  .description('Seed database with test data')
  .action(async () => {
    try {
      await connectDB();
      await seedDatabase();
      await closeDB();
    } catch (error) {
      console.error('✗ Seeding failed:', error.message);
      process.exit(1);
    }
  });

program
  .command('reset')
  .description('Drop and recreate all tables (WARNING: This will delete all data)')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (options) => {
    try {
      if (!options.yes) {
        const answer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: 'Are you sure you want to reset the database? This will delete ALL data.',
            default: false
          }
        ]);
        if (!answer.confirm) {
          console.log('Reset cancelled.');
          return;
        }
      }
      
      await connectDB();
      await dropTables();
      await createTables();
      console.log('✓ Database reset completed');
      await closeDB();
    } catch (error) {
      console.error('✗ Reset failed:', error.message);
      process.exit(1);
    }
  });

// User commands
program
  .command('list-users')
  .description('List all users')
  .option('-l, --limit <limit>', 'Limit results', '100')
  .option('-o, --offset <offset>', 'Offset for pagination', '0')
  .action(async (options) => {
    try {
      await connectDB();
      const limit = parseInt(options.limit);
      const offset = parseInt(options.offset);
      const users = await User.findAll(limit, offset);
      const total = await User.count();
      
      if (users.length === 0) {
        console.log('No users found.');
      } else {
        console.log(`\nFound ${users.length} user(s) (Total: ${total}):\n`);
        console.table(users.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email,
          created: new Date(u.created_at).toLocaleDateString()
        })));
      }
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to list users:', error.message);
      process.exit(1);
    }
  });

program
  .command('create-user')
  .description('Create a new user')
  .option('-u, --username <username>', 'Username')
  .option('-e, --email <email>', 'Email')
  .option('-p, --password <password>', 'Password')
  .action(async (options) => {
    try {
      let { username, email, password } = options;
      
      if (!username || !email || !password) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'username',
            message: 'Enter username:',
            validate: (input) => input.length >= 3 || 'Username must be at least 3 characters',
            when: () => !username
          },
          {
            type: 'input',
            name: 'email',
            message: 'Enter email:',
            validate: (input) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) || 'Invalid email address',
            when: () => !email
          },
          {
            type: 'password',
            name: 'password',
            message: 'Enter password:',
            validate: (input) => input.length >= 6 || 'Password must be at least 6 characters',
            when: () => !password
          }
        ]);
        username = username || answers.username;
        email = email || answers.email;
        password = password || answers.password;
      }

      await connectDB();
      const user = await User.create(username, email, password);
      console.log('\n✓ User created successfully:');
      console.log(`  ID: ${user.id}`);
      console.log(`  Username: ${user.username}`);
      console.log(`  Email: ${user.email}`);
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to create user:', error.message);
      process.exit(1);
    }
  });

// Account commands
program
  .command('create-account')
  .description('Create a new account')
  .option('-u, --user-id <userId>', 'User ID')
  .option('-t, --type <type>', 'Account type (checking, savings, business)')
  .action(async (options) => {
    try {
      let { userId, type } = options;
      
      if (!userId || !type) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'userId',
            message: 'Enter user ID:',
            validate: (input) => !isNaN(input) || 'User ID must be a number',
            when: () => !userId
          },
          {
            type: 'list',
            name: 'type',
            message: 'Select account type:',
            choices: ['checking', 'savings', 'business'],
            when: () => !type
          }
        ]);
        userId = userId || answers.userId;
        type = type || answers.type;
      }

      await connectDB();
      const account = await Account.create(parseInt(userId), type);
      console.log('\n✓ Account created successfully:');
      console.log(`  ID: ${account.id}`);
      console.log(`  Account Number: ${account.account_number}`);
      console.log(`  Type: ${account.account_type}`);
      console.log(`  Balance: $${parseFloat(account.balance).toFixed(2)}`);
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to create account:', error.message);
      process.exit(1);
    }
  });

program
  .command('list-accounts')
  .description('List accounts (all or for a specific user)')
  .option('-u, --user-id <userId>', 'User ID (optional - lists all if not provided)')
  .option('-l, --limit <limit>', 'Limit results', '100')
  .option('-o, --offset <offset>', 'Offset for pagination', '0')
  .action(async (options) => {
    try {
      await connectDB();
      
      if (options.userId) {
        const accounts = await Account.findByUserId(parseInt(options.userId));
        if (accounts.length === 0) {
          console.log('No accounts found for this user.');
        } else {
          console.log(`\nFound ${accounts.length} account(s) for user ${options.userId}:\n`);
          console.table(accounts.map(acc => ({
            id: acc.id,
            account_number: acc.account_number,
            type: acc.account_type,
            balance: `$${parseFloat(acc.balance).toFixed(2)}`,
            created: new Date(acc.created_at).toLocaleDateString()
          })));
        }
      } else {
        const limit = parseInt(options.limit);
        const offset = parseInt(options.offset);
        const accounts = await Account.findAll(limit, offset);
        const total = await Account.count();
        
        if (accounts.length === 0) {
          console.log('No accounts found.');
        } else {
          console.log(`\nFound ${accounts.length} account(s) (Total: ${total}):\n`);
          console.table(accounts.map(acc => ({
            id: acc.id,
            account_number: acc.account_number,
            type: acc.account_type,
            balance: `$${parseFloat(acc.balance).toFixed(2)}`,
            owner: acc.username || acc.email,
            created: new Date(acc.created_at).toLocaleDateString()
          })));
        }
      }
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to list accounts:', error.message);
      process.exit(1);
    }
  });

// Transaction commands
program
  .command('deposit')
  .description('Deposit money to an account')
  .option('-a, --account-id <accountId>', 'Account ID')
  .option('-m, --amount <amount>', 'Amount')
  .action(async (options) => {
    try {
      let { accountId, amount } = options;
      
      if (!accountId || !amount) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'accountId',
            message: 'Enter account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number',
            when: () => !accountId
          },
          {
            type: 'input',
            name: 'amount',
            message: 'Enter amount:',
            validate: (input) => {
              const num = parseFloat(input);
              return (!isNaN(num) && num > 0) || 'Amount must be a positive number';
            },
            when: () => !amount
          }
        ]);
        accountId = accountId || answers.accountId;
        amount = amount || answers.amount;
      }

      await connectDB();
      const account = await Account.findById(parseInt(accountId));
      if (!account) {
        console.error('✗ Account not found');
        await closeDB();
        process.exit(1);
      }
      
      const newBalance = parseFloat(account.balance) + parseFloat(amount);
      await Account.updateBalance(account.id, newBalance);
      await Transaction.create(null, account.id, parseFloat(amount), 'deposit');
      
      console.log('\n✓ Deposit successful!');
      console.log(`  Account: ${account.account_number}`);
      console.log(`  Amount: $${parseFloat(amount).toFixed(2)}`);
      console.log(`  New Balance: $${newBalance.toFixed(2)}`);
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to deposit:', error.message);
      process.exit(1);
    }
  });

program
  .command('withdraw')
  .description('Withdraw money from an account')
  .option('-a, --account-id <accountId>', 'Account ID')
  .option('-m, --amount <amount>', 'Amount')
  .action(async (options) => {
    try {
      let { accountId, amount } = options;
      
      if (!accountId || !amount) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'accountId',
            message: 'Enter account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number',
            when: () => !accountId
          },
          {
            type: 'input',
            name: 'amount',
            message: 'Enter amount:',
            validate: (input) => {
              const num = parseFloat(input);
              return (!isNaN(num) && num > 0) || 'Amount must be a positive number';
            },
            when: () => !amount
          }
        ]);
        accountId = accountId || answers.accountId;
        amount = amount || answers.amount;
      }

      await connectDB();
      const account = await Account.findById(parseInt(accountId));
      if (!account) {
        console.error('✗ Account not found');
        await closeDB();
        process.exit(1);
      }
      
      const currentBalance = parseFloat(account.balance);
      const amountNum = parseFloat(amount);
      
      if (currentBalance < amountNum) {
        console.error('✗ Insufficient funds');
        console.log(`  Current balance: $${currentBalance.toFixed(2)}`);
        await closeDB();
        process.exit(1);
      }
      
      const newBalance = currentBalance - amountNum;
      await Account.updateBalance(account.id, newBalance);
      await Transaction.create(account.id, null, amountNum, 'withdrawal');
      
      console.log('\n✓ Withdrawal successful!');
      console.log(`  Account: ${account.account_number}`);
      console.log(`  Amount: $${amountNum.toFixed(2)}`);
      console.log(`  New Balance: $${newBalance.toFixed(2)}`);
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to withdraw:', error.message);
      process.exit(1);
    }
  });

program
  .command('transfer')
  .description('Transfer money between accounts')
  .option('-f, --from <accountId>', 'From account ID')
  .option('-t, --to <accountId>', 'To account ID')
  .option('-m, --amount <amount>', 'Amount')
  .action(async (options) => {
    try {
      let { from, to, amount } = options;
      
      if (!from || !to || !amount) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'from',
            message: 'Enter from account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number',
            when: () => !from
          },
          {
            type: 'input',
            name: 'to',
            message: 'Enter to account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number',
            when: () => !to
          },
          {
            type: 'input',
            name: 'amount',
            message: 'Enter amount:',
            validate: (input) => {
              const num = parseFloat(input);
              return (!isNaN(num) && num > 0) || 'Amount must be a positive number';
            },
            when: () => !amount
          }
        ]);
        from = from || answers.from;
        to = to || answers.to;
        amount = amount || answers.amount;
      }

      await connectDB();
      const fromAccount = await Account.findById(parseInt(from));
      const toAccount = await Account.findById(parseInt(to));
      
      if (!fromAccount || !toAccount) {
        console.error('✗ One or both accounts not found');
        await closeDB();
        process.exit(1);
      }
      
      if (parseInt(from) === parseInt(to)) {
        console.error('✗ Cannot transfer to the same account');
        await closeDB();
        process.exit(1);
      }
      
      const currentBalance = parseFloat(fromAccount.balance);
      const amountNum = parseFloat(amount);
      
      if (currentBalance < amountNum) {
        console.error('✗ Insufficient funds');
        console.log(`  Current balance: $${currentBalance.toFixed(2)}`);
        await closeDB();
        process.exit(1);
      }
      
      const fromNewBalance = currentBalance - amountNum;
      const toNewBalance = parseFloat(toAccount.balance) + amountNum;
      
      await Account.updateBalance(fromAccount.id, fromNewBalance);
      await Account.updateBalance(toAccount.id, toNewBalance);
      await Transaction.create(fromAccount.id, toAccount.id, amountNum, 'transfer');
      
      console.log('\n✓ Transfer successful!');
      console.log(`  From: ${fromAccount.account_number} (Balance: $${fromNewBalance.toFixed(2)})`);
      console.log(`  To: ${toAccount.account_number} (Balance: $${toNewBalance.toFixed(2)})`);
      console.log(`  Amount: $${amountNum.toFixed(2)}`);
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to transfer:', error.message);
      process.exit(1);
    }
  });

program
  .command('balance')
  .description('Get account balance')
  .option('-a, --account-id <accountId>', 'Account ID')
  .action(async (options) => {
    try {
      let accountId = options.accountId;
      
      if (!accountId) {
        const answer = await inquirer.prompt([
          {
            type: 'input',
            name: 'accountId',
            message: 'Enter account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number'
          }
        ]);
        accountId = answer.accountId;
      }

      await connectDB();
      const account = await Account.findById(parseInt(accountId));
      if (!account) {
        console.error('✗ Account not found');
        await closeDB();
        process.exit(1);
      }
      
      console.log('\nAccount Information:');
      console.log(`  Account Number: ${account.account_number}`);
      console.log(`  Type: ${account.account_type}`);
      console.log(`  Balance: $${parseFloat(account.balance).toFixed(2)}`);
      console.log(`  Created: ${new Date(account.created_at).toLocaleString()}`);
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to get balance:', error.message);
      process.exit(1);
    }
  });

program
  .command('list-transactions')
  .description('List all transactions')
  .option('-l, --limit <limit>', 'Limit results', '100')
  .option('-o, --offset <offset>', 'Offset for pagination', '0')
  .action(async (options) => {
    try {
      await connectDB();
      const limit = parseInt(options.limit);
      const offset = parseInt(options.offset);
      const transactions = await Transaction.findAll(limit, offset);
      const total = await Transaction.count();
      
      if (transactions.length === 0) {
        console.log('No transactions found.');
      } else {
        console.log(`\nFound ${transactions.length} transaction(s) (Total: ${total}):\n`);
        console.table(transactions.map(t => ({
          id: t.id,
          type: t.type,
          amount: `$${parseFloat(t.amount).toFixed(2)}`,
          from: t.from_account_number || 'N/A',
          to: t.to_account_number || 'N/A',
          timestamp: new Date(t.timestamp).toLocaleString()
        })));
      }
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to list transactions:', error.message);
      process.exit(1);
    }
  });

program
  .command('history')
  .description('Get transaction history for a user')
  .option('-u, --user-id <userId>', 'User ID')
  .option('-t, --type <type>', 'Filter by type (deposit, withdrawal, transfer)')
  .option('-l, --limit <limit>', 'Limit results', '20')
  .action(async (options) => {
    try {
      let userId = options.userId;
      
      if (!userId) {
        const answer = await inquirer.prompt([
          {
            type: 'input',
            name: 'userId',
            message: 'Enter user ID:',
            validate: (input) => !isNaN(input) || 'User ID must be a number'
          }
        ]);
        userId = answer.userId;
      }

      await connectDB();
      const filters = {
        type: options.type,
        limit: parseInt(options.limit)
      };
      const transactions = await Transaction.findByUserId(parseInt(userId), filters);
      
      if (transactions.length === 0) {
        console.log('No transactions found.');
      } else {
        console.log(`\nFound ${transactions.length} transaction(s):\n`);
        console.table(transactions.map(t => ({
          id: t.id,
          type: t.type,
          amount: `$${parseFloat(t.amount).toFixed(2)}`,
          from: t.from_account_number || 'N/A',
          to: t.to_account_number || 'N/A',
          timestamp: new Date(t.timestamp).toLocaleString()
        })));
      }
      await closeDB();
    } catch (error) {
      console.error('✗ Failed to get history:', error.message);
      process.exit(1);
    }
  });

// Interactive mode
async function interactiveMode() {
  console.log('\n🏦 Banking System CLI - Interactive Mode\n');
  
  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: '📊 Database Operations', value: 'db' },
          { name: '👤 User Management', value: 'user' },
          { name: '💳 Account Management', value: 'account' },
          { name: '💰 Transaction Operations', value: 'transaction' },
          { name: '❌ Exit', value: 'exit' }
        ]
      }
    ]);

    if (action === 'exit') {
      console.log('\nGoodbye! 👋\n');
      break;
    }

    try {
      switch (action) {
        case 'db':
          await handleDatabaseOperations();
          break;
        case 'user':
          await handleUserOperations();
          break;
        case 'account':
          await handleAccountOperations();
          break;
        case 'transaction':
          await handleTransactionOperations();
          break;
      }
    } catch (error) {
      console.error('\n✗ Error:', error.message);
    }
    
    console.log(''); // Add spacing
  }
}

async function handleDatabaseOperations() {
  const { operation } = await inquirer.prompt([
    {
      type: 'list',
      name: 'operation',
      message: 'Select database operation:',
      choices: [
        { name: 'Run Migrations', value: 'migrate' },
        { name: 'Seed Database', value: 'seed' },
        { name: 'Reset Database (DANGER)', value: 'reset' },
        { name: 'Execute SQL Query', value: 'sql' },
        { name: 'Back', value: 'back' }
      ]
    }
  ]);

  if (operation === 'back') return;

  await connectDB();
  try {
    switch (operation) {
      case 'migrate':
        await createTables();
        console.log('\n✓ Migrations completed successfully');
        break;
      case 'seed':
        await seedDatabase();
        break;
      case 'reset':
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: '⚠️  WARNING: This will delete ALL data. Are you sure?',
            default: false
          }
        ]);
        if (confirm) {
          await dropTables();
          await createTables();
          console.log('\n✓ Database reset completed');
        } else {
          console.log('Reset cancelled.');
        }
        break;
      case 'sql':
        await handleSQLQuery();
        break;
    }
  } finally {
    await closeDB();
  }
}

async function handleSQLQuery() {
  const { queryType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'queryType',
      message: 'Select query type:',
      choices: [
        { name: 'SELECT (Read)', value: 'select' },
        { name: 'INSERT (Create)', value: 'insert' },
        { name: 'UPDATE (Modify)', value: 'update' },
        { name: 'DELETE (Remove)', value: 'delete' },
        { name: 'Custom SQL', value: 'custom' }
      ]
    }
  ]);

  const { getPool } = await import('./config/database.js');
  const pool = getPool();
  
  if (queryType === 'custom') {
    const { query } = await inquirer.prompt([
      {
        type: 'input',
        name: 'query',
        message: 'Enter SQL query:',
        validate: (input) => input.trim().length > 0 || 'Query cannot be empty'
      }
    ]);

    try {
      const result = await pool.query(query.trim());
      if (result.rows && result.rows.length > 0) {
        console.log(`\n✓ Query executed successfully. ${result.rows.length} row(s) returned:\n`);
        console.table(result.rows);
      } else {
        console.log(`\n✓ Query executed successfully. ${result.rowCount || 0} row(s) affected.`);
      }
    } catch (error) {
      console.error('\n✗ SQL Error:', error.message);
    }
  } else {
    // Provide templates for common operations
    let query = '';
    let params = [];
    
    switch (queryType) {
      case 'select':
        const { selectTable } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectTable',
            message: 'Select table:',
            choices: ['users', 'accounts', 'transactions']
          }
        ]);
        query = `SELECT * FROM ${selectTable} LIMIT 100`;
        break;
      case 'insert':
        const { insertTable } = await inquirer.prompt([
          {
            type: 'list',
            name: 'insertTable',
            message: 'Select table:',
            choices: ['users', 'accounts']
          }
        ]);
        if (insertTable === 'users') {
          const userData = await inquirer.prompt([
            { type: 'input', name: 'username', message: 'Username:' },
            { type: 'input', name: 'email', message: 'Email:' },
            { type: 'password', name: 'password', message: 'Password:' }
          ]);
          const bcrypt = (await import('bcryptjs')).default;
          const hashedPassword = await bcrypt.hash(userData.password, 10);
          query = `INSERT INTO users (username, email, password_hash, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`;
          params = [userData.username, userData.email, hashedPassword];
        }
        break;
      case 'update':
        const { updateTable, updateId, updateField, updateValue } = await inquirer.prompt([
          { type: 'list', name: 'updateTable', message: 'Select table:', choices: ['users', 'accounts'] },
          { type: 'input', name: 'updateId', message: 'Record ID:' },
          { type: 'input', name: 'updateField', message: 'Field to update:' },
          { type: 'input', name: 'updateValue', message: 'New value:' }
        ]);
        query = `UPDATE ${updateTable} SET ${updateField} = $1 WHERE id = $2 RETURNING *`;
        params = [updateValue, updateId];
        break;
      case 'delete':
        const { deleteTable, deleteId } = await inquirer.prompt([
          { type: 'list', name: 'deleteTable', message: 'Select table:', choices: ['users', 'accounts', 'transactions'] },
          { type: 'input', name: 'deleteId', message: 'Record ID to delete:' }
        ]);
        const { confirmDelete } = await inquirer.prompt([
          { type: 'confirm', name: 'confirmDelete', message: '⚠️  Are you sure you want to delete this record?', default: false }
        ]);
        if (!confirmDelete) {
          console.log('Delete cancelled.');
          return;
        }
        query = `DELETE FROM ${deleteTable} WHERE id = $1 RETURNING *`;
        params = [deleteId];
        break;
    }

    if (query) {
      try {
        const result = await pool.query(query, params);
        if (result.rows && result.rows.length > 0) {
          console.log(`\n✓ Query executed successfully. ${result.rows.length} row(s) returned:\n`);
          console.table(result.rows);
        } else {
          console.log(`\n✓ Query executed successfully. ${result.rowCount || 0} row(s) affected.`);
        }
      } catch (error) {
        console.error('\n✗ SQL Error:', error.message);
      }
    }
  }
}

async function handleUserOperations() {
  const { operation } = await inquirer.prompt([
    {
      type: 'list',
      name: 'operation',
      message: 'Select user operation:',
      choices: [
        { name: 'List All Users', value: 'list' },
        { name: 'Create User', value: 'create' },
        { name: 'Back', value: 'back' }
      ]
    }
  ]);

  if (operation === 'back') return;

  await connectDB();
  try {
    if (operation === 'list') {
      const users = await User.findAll(100, 0);
      const total = await User.count();
      if (users.length === 0) {
        console.log('\nNo users found.');
      } else {
        console.log(`\nFound ${users.length} user(s) (Total: ${total}):\n`);
        console.table(users.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email,
          created: new Date(u.created_at).toLocaleDateString()
        })));
      }
    } else if (operation === 'create') {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'username',
          message: 'Enter username:',
          validate: (input) => input.length >= 3 || 'Username must be at least 3 characters'
        },
        {
          type: 'input',
          name: 'email',
          message: 'Enter email:',
          validate: (input) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) || 'Invalid email address'
        },
        {
          type: 'password',
          name: 'password',
          message: 'Enter password (PCI-DSS: min 8 chars, uppercase, lowercase, digit, special char):',
          validate: (input) => {
            if (input.length < 8) return 'Password must be at least 8 characters long';
            if (!/[A-Z]/.test(input)) return 'Password must contain at least one uppercase letter';
            if (!/[a-z]/.test(input)) return 'Password must contain at least one lowercase letter';
            if (!/[0-9]/.test(input)) return 'Password must contain at least one digit';
            if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(input)) return 'Password must contain at least one special character';
            return true;
          }
        }
      ]);

      const user = await User.create(answers.username, answers.email, answers.password);
      console.log('\n✓ User created successfully:');
      console.log(`  ID: ${user.id}`);
      console.log(`  Username: ${user.username}`);
      console.log(`  Email: ${user.email}`);
    }
  } finally {
    await closeDB();
  }
}

async function handleAccountOperations() {
  const { operation } = await inquirer.prompt([
    {
      type: 'list',
      name: 'operation',
      message: 'Select account operation:',
      choices: [
        { name: 'List All Accounts', value: 'list-all' },
        { name: 'List User Accounts', value: 'list' },
        { name: 'Create Account', value: 'create' },
        { name: 'View Balance', value: 'balance' },
        { name: 'Back', value: 'back' }
      ]
    }
  ]);

  if (operation === 'back') return;

  await connectDB();
  try {
    switch (operation) {
      case 'list-all':
        const allAccounts = await Account.findAll(100, 0);
        const totalAccounts = await Account.count();
        if (allAccounts.length === 0) {
          console.log('\nNo accounts found.');
        } else {
          console.log(`\nFound ${allAccounts.length} account(s) (Total: ${totalAccounts}):\n`);
          console.table(allAccounts.map(acc => ({
            id: acc.id,
            account_number: acc.account_number,
            type: acc.account_type,
            balance: `$${parseFloat(acc.balance).toFixed(2)}`,
            owner: acc.username || acc.email
          })));
        }
        break;
      case 'create':
        const createAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'userId',
            message: 'Enter user ID:',
            validate: (input) => !isNaN(input) || 'User ID must be a number'
          },
          {
            type: 'list',
            name: 'type',
            message: 'Select account type:',
            choices: ['checking', 'savings', 'business']
          }
        ]);
        const account = await Account.create(parseInt(createAnswers.userId), createAnswers.type);
        console.log('\n✓ Account created successfully:');
        console.log(`  ID: ${account.id}`);
        console.log(`  Account Number: ${account.account_number}`);
        console.log(`  Type: ${account.account_type}`);
        console.log(`  Balance: $${parseFloat(account.balance).toFixed(2)}`);
        break;
      case 'list':
        const listAnswer = await inquirer.prompt([
          {
            type: 'input',
            name: 'userId',
            message: 'Enter user ID:',
            validate: (input) => !isNaN(input) || 'User ID must be a number'
          }
        ]);
        const accounts = await Account.findByUserId(parseInt(listAnswer.userId));
        if (accounts.length === 0) {
          console.log('\nNo accounts found for this user.');
        } else {
          console.log(`\nFound ${accounts.length} account(s):\n`);
          console.table(accounts.map(acc => ({
            id: acc.id,
            account_number: acc.account_number,
            type: acc.account_type,
            balance: `$${parseFloat(acc.balance).toFixed(2)}`
          })));
        }
        break;
      case 'balance':
        const balanceAnswer = await inquirer.prompt([
          {
            type: 'input',
            name: 'accountId',
            message: 'Enter account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number'
          }
        ]);
        const acc = await Account.findById(parseInt(balanceAnswer.accountId));
        if (!acc) {
          console.log('\n✗ Account not found');
        } else {
          console.log('\nAccount Information:');
          console.log(`  Account Number: ${acc.account_number}`);
          console.log(`  Type: ${acc.account_type}`);
          console.log(`  Balance: $${parseFloat(acc.balance).toFixed(2)}`);
        }
        break;
    }
  } finally {
    await closeDB();
  }
}

async function handleTransactionOperations() {
  const { operation } = await inquirer.prompt([
    {
      type: 'list',
      name: 'operation',
      message: 'Select transaction operation:',
      choices: [
        { name: 'List All Transactions', value: 'list-all' },
        { name: 'Deposit', value: 'deposit' },
        { name: 'Withdraw', value: 'withdraw' },
        { name: 'Transfer', value: 'transfer' },
        { name: 'View User History', value: 'history' },
        { name: 'Back', value: 'back' }
      ]
    }
  ]);

  if (operation === 'back') return;

  await connectDB();
  try {
    switch (operation) {
      case 'list-all':
        const allTransactions = await Transaction.findAll(100, 0);
        const totalTransactions = await Transaction.count();
        if (allTransactions.length === 0) {
          console.log('\nNo transactions found.');
        } else {
          console.log(`\nFound ${allTransactions.length} transaction(s) (Total: ${totalTransactions}):\n`);
          console.table(allTransactions.map(t => ({
            id: t.id,
            type: t.type,
            amount: `$${parseFloat(t.amount).toFixed(2)}`,
            from: t.from_account_number || 'N/A',
            to: t.to_account_number || 'N/A',
            timestamp: new Date(t.timestamp).toLocaleString()
          })));
        }
        break;
      case 'deposit':
        const depositAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'accountId',
            message: 'Enter account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number'
          },
          {
            type: 'input',
            name: 'amount',
            message: 'Enter amount:',
            validate: (input) => {
              const num = parseFloat(input);
              return (!isNaN(num) && num > 0) || 'Amount must be a positive number';
            }
          }
        ]);
        const depositAccount = await Account.findById(parseInt(depositAnswers.accountId));
        if (!depositAccount) {
          console.log('\n✗ Account not found');
          break;
        }
        const depositNewBalance = parseFloat(depositAccount.balance) + parseFloat(depositAnswers.amount);
        await Account.updateBalance(depositAccount.id, depositNewBalance);
        await Transaction.create(null, depositAccount.id, parseFloat(depositAnswers.amount), 'deposit');
        console.log('\n✓ Deposit successful!');
        console.log(`  New Balance: $${depositNewBalance.toFixed(2)}`);
        break;
      case 'withdraw':
        const withdrawAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'accountId',
            message: 'Enter account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number'
          },
          {
            type: 'input',
            name: 'amount',
            message: 'Enter amount:',
            validate: (input) => {
              const num = parseFloat(input);
              return (!isNaN(num) && num > 0) || 'Amount must be a positive number';
            }
          }
        ]);
        const withdrawAccount = await Account.findById(parseInt(withdrawAnswers.accountId));
        if (!withdrawAccount) {
          console.log('\n✗ Account not found');
          break;
        }
        const withdrawBalance = parseFloat(withdrawAccount.balance);
        const withdrawAmount = parseFloat(withdrawAnswers.amount);
        if (withdrawBalance < withdrawAmount) {
          console.log('\n✗ Insufficient funds');
          console.log(`  Current balance: $${withdrawBalance.toFixed(2)}`);
          break;
        }
        const withdrawNewBalance = withdrawBalance - withdrawAmount;
        await Account.updateBalance(withdrawAccount.id, withdrawNewBalance);
        await Transaction.create(withdrawAccount.id, null, withdrawAmount, 'withdrawal');
        console.log('\n✓ Withdrawal successful!');
        console.log(`  New Balance: $${withdrawNewBalance.toFixed(2)}`);
        break;
      case 'transfer':
        const transferAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'from',
            message: 'Enter from account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number'
          },
          {
            type: 'input',
            name: 'to',
            message: 'Enter to account ID:',
            validate: (input) => !isNaN(input) || 'Account ID must be a number'
          },
          {
            type: 'input',
            name: 'amount',
            message: 'Enter amount:',
            validate: (input) => {
              const num = parseFloat(input);
              return (!isNaN(num) && num > 0) || 'Amount must be a positive number';
            }
          }
        ]);
        const fromAcc = await Account.findById(parseInt(transferAnswers.from));
        const toAcc = await Account.findById(parseInt(transferAnswers.to));
        if (!fromAcc || !toAcc) {
          console.log('\n✗ One or both accounts not found');
          break;
        }
        if (parseInt(transferAnswers.from) === parseInt(transferAnswers.to)) {
          console.log('\n✗ Cannot transfer to the same account');
          break;
        }
        const fromBalance = parseFloat(fromAcc.balance);
        const transferAmount = parseFloat(transferAnswers.amount);
        if (fromBalance < transferAmount) {
          console.log('\n✗ Insufficient funds');
          console.log(`  Current balance: $${fromBalance.toFixed(2)}`);
          break;
        }
        const fromNewBal = fromBalance - transferAmount;
        const toNewBal = parseFloat(toAcc.balance) + transferAmount;
        await Account.updateBalance(fromAcc.id, fromNewBal);
        await Account.updateBalance(toAcc.id, toNewBal);
        await Transaction.create(fromAcc.id, toAcc.id, transferAmount, 'transfer');
        console.log('\n✓ Transfer successful!');
        console.log(`  From: $${fromNewBal.toFixed(2)}`);
        console.log(`  To: $${toNewBal.toFixed(2)}`);
        break;
      case 'history':
        const historyAnswer = await inquirer.prompt([
          {
            type: 'input',
            name: 'userId',
            message: 'Enter user ID:',
            validate: (input) => !isNaN(input) || 'User ID must be a number'
          }
        ]);
        const transactions = await Transaction.findByUserId(parseInt(historyAnswer.userId), { limit: 50 });
        if (transactions.length === 0) {
          console.log('\nNo transactions found.');
        } else {
          console.log(`\nFound ${transactions.length} transaction(s):\n`);
          console.table(transactions.map(t => ({
            id: t.id,
            type: t.type,
            amount: `$${parseFloat(t.amount).toFixed(2)}`,
            from: t.from_account_number || 'N/A',
            to: t.to_account_number || 'N/A',
            timestamp: new Date(t.timestamp).toLocaleString()
          })));
        }
        break;
    }
  } finally {
    await closeDB();
  }
}

// Parse arguments
if (process.argv.length > 2) {
  program.parse();
} else {
  interactiveMode();
}
