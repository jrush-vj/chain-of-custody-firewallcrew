import { User } from '../models/User.js';
import { Account } from '../models/Account.js';
import { Transaction } from '../models/Transaction.js';

export const seedDatabase = async () => {
  try {
    console.log('Seeding database...');

    // Create test users
    const user1 = await User.create('john_doe', 'john@example.com', 'password123');
    const user2 = await User.create('jane_smith', 'jane@example.com', 'password123');
    const user3 = await User.create('bob_wilson', 'bob@example.com', 'password123');

    console.log('Created test users');

    // Create accounts
    const account1 = await Account.create(user1.id, 'checking');
    const account2 = await Account.create(user1.id, 'savings');
    const account3 = await Account.create(user2.id, 'checking');
    const account4 = await Account.create(user3.id, 'business');

    console.log('Created test accounts');

    // Create initial deposits
    await Transaction.create(null, account1.id, 1000.00, 'deposit');
    await Account.updateBalance(account1.id, 1000.00);

    await Transaction.create(null, account2.id, 5000.00, 'deposit');
    await Account.updateBalance(account2.id, 5000.00);

    await Transaction.create(null, account3.id, 2000.00, 'deposit');
    await Account.updateBalance(account3.id, 2000.00);

    await Transaction.create(null, account4.id, 10000.00, 'deposit');
    await Account.updateBalance(account4.id, 10000.00);

    // Create some transfers
    await Transaction.create(account1.id, account2.id, 200.00, 'transfer');
    await Account.updateBalance(account1.id, 800.00);
    await Account.updateBalance(account2.id, 5200.00);

    await Transaction.create(account3.id, account1.id, 100.00, 'transfer');
    await Account.updateBalance(account3.id, 1900.00);
    await Account.updateBalance(account1.id, 900.00);

    console.log('Created test transactions');
    console.log('Database seeded successfully!');
  } catch (error) {
    console.error('Error seeding database:', error);
    throw error;
  }
};




