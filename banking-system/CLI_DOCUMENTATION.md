# Banking System CLI Documentation

## Overview

The Banking System CLI is an interactive command-line tool for managing the banking system. It supports both interactive mode and direct command execution.

## Getting Started

### Launch Interactive Mode

```bash
# Launch interactive mode (default)
node backend/cli.js
# or
node backend/cli.js -i
# or
node backend/cli.js --interactive
```

### Show Help

```bash
# Show help menu
node backend/cli.js -h
# or
node backend/cli.js --help
```

## Command Reference

### Database Operations

#### Run Migrations
Create database tables.

```bash
node backend/cli.js migrate
```

**API Equivalent:**
- Migrations are run automatically when the server starts
- No direct API endpoint (server-side only)

#### Seed Database
Populate database with test data.

```bash
node backend/cli.js seed
```

**API Equivalent:**
- No direct API endpoint (CLI only)
- Test users are created:
  - `john@example.com` / `password123`
  - `jane@example.com` / `password123`
  - `bob@example.com` / `password123`

#### Reset Database
⚠️ **WARNING:** This will delete ALL data!

```bash
# With confirmation prompt
node backend/cli.js reset

# Skip confirmation
node backend/cli.js reset -y
# or
node backend/cli.js reset --yes
```

**API Equivalent:**
- No direct API endpoint (CLI only)

---

### User Management

#### Create User

**Interactive:**
```bash
node backend/cli.js create-user
```

**With Options:**
```bash
node backend/cli.js create-user -u username -e email@example.com -p password
# or
node backend/cli.js create-user --username john_doe --email john@example.com --password secret123
```

**API Equivalent:**
```bash
POST /api/auth/register
Content-Type: application/json

{
  "username": "john_doe",
  "email": "john@example.com",
  "password": "secret123"
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"john_doe","email":"john@example.com","password":"secret123"}'
```

---

### Account Management

#### Create Account

**Interactive:**
```bash
node backend/cli.js create-account
```

**With Options:**
```bash
node backend/cli.js create-account -u 1 -t checking
# or
node backend/cli.js create-account --user-id 1 --type savings
```

**Account Types:**
- `checking`
- `savings`
- `business`

**API Equivalent:**
```bash
POST /api/accounts
Authorization: Bearer <token>
Content-Type: application/json

{
  "account_type": "checking"
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:5000/api/accounts \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account_type":"checking"}'
```

#### List Accounts

**Interactive:**
```bash
node backend/cli.js list-accounts
```

**With Options:**
```bash
node backend/cli.js list-accounts -u 1
# or
node backend/cli.js list-accounts --user-id 1
```

**API Equivalent:**
```bash
GET /api/accounts
Authorization: Bearer <token>
```

**cURL Example:**
```bash
curl -X GET http://localhost:5000/api/accounts \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Get Account Balance

**Interactive:**
```bash
node backend/cli.js balance
```

**With Options:**
```bash
node backend/cli.js balance -a 1
# or
node backend/cli.js balance --account-id 1
```

**API Equivalent:**
```bash
GET /api/transactions/balance/:account_id
Authorization: Bearer <token>
```

**cURL Example:**
```bash
curl -X GET http://localhost:5000/api/transactions/balance/1 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### Transaction Operations

#### Deposit Money

**Interactive:**
```bash
node backend/cli.js deposit
```

**With Options:**
```bash
node backend/cli.js deposit -a 1 -m 100.50
# or
node backend/cli.js deposit --account-id 1 --amount 100.50
```

**API Equivalent:**
```bash
POST /api/transactions/deposit
Authorization: Bearer <token>
Content-Type: application/json

{
  "account_id": 1,
  "amount": 100.50
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:5000/api/transactions/deposit \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account_id":1,"amount":100.50}'
```

#### Withdraw Money

**Interactive:**
```bash
node backend/cli.js withdraw
```

**With Options:**
```bash
node backend/cli.js withdraw -a 1 -m 50.00
# or
node backend/cli.js withdraw --account-id 1 --amount 50.00
```

**API Equivalent:**
```bash
POST /api/transactions/withdraw
Authorization: Bearer <token>
Content-Type: application/json

{
  "account_id": 1,
  "amount": 50.00
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:5000/api/transactions/withdraw \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account_id":1,"amount":50.00}'
```

#### Transfer Money

**Interactive:**
```bash
node backend/cli.js transfer
```

**With Options:**
```bash
node backend/cli.js transfer -f 1 -t 2 -m 25.00
# or
node backend/cli.js transfer --from 1 --to 2 --amount 25.00
```

**API Equivalent:**
```bash
POST /api/transactions/transfer
Authorization: Bearer <token>
Content-Type: application/json

{
  "from_account_id": 1,
  "to_account_id": 2,
  "amount": 25.00
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:5000/api/transactions/transfer \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from_account_id":1,"to_account_id":2,"amount":25.00}'
```

#### View Transaction History

**Interactive:**
```bash
node backend/cli.js history
```

**With Options:**
```bash
# Basic usage
node backend/cli.js history -u 1

# With filters
node backend/cli.js history -u 1 -t deposit -l 10
# or
node backend/cli.js history --user-id 1 --type deposit --limit 10
```

**Transaction Types:**
- `deposit`
- `withdrawal`
- `transfer`

**API Equivalent:**
```bash
GET /api/transactions?page=1&limit=20&type=deposit
Authorization: Bearer <token>
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/transactions?page=1&limit=20&type=deposit" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Interactive Mode

When launched without arguments or with `-i` flag, the CLI enters interactive mode with a menu-driven interface:

```
🏦 Banking System CLI - Interactive Mode

? What would you like to do?
  📊 Database Operations
  👤 User Management
  💳 Account Management
  💰 Transaction Operations
  ❌ Exit
```

### Interactive Mode Features

- **Menu-driven navigation** - Easy to use without remembering commands
- **Input validation** - Automatic validation of user inputs
- **Confirmation prompts** - Safety prompts for destructive operations
- **Formatted output** - Clean, readable results with tables and formatting

---

## Authentication for API Calls

Most API endpoints require authentication. To use the API:

1. **Register/Login** to get a JWT token:
```bash
# Register
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"user","email":"user@example.com","password":"password123"}'

# Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'
```

2. **Use the token** in subsequent requests:
```bash
curl -X GET http://localhost:5000/api/accounts \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Complete API Reference

For complete API documentation with request/response schemas, visit:
- **Swagger UI:** http://localhost:5000/api-docs (when server is running)

---

## Examples

### Complete Workflow Example

```bash
# 1. Start the database
npm run docker:up

# 2. Run migrations
node backend/cli.js migrate

# 3. Seed test data
node backend/cli.js seed

# 4. Create a new user (interactive)
node backend/cli.js create-user

# 5. Create an account for user ID 1
node backend/cli.js create-account -u 1 -t checking

# 6. Deposit $100
node backend/cli.js deposit -a 1 -m 100

# 7. Check balance
node backend/cli.js balance -a 1

# 8. View transaction history
node backend/cli.js history -u 1
```

### Using Interactive Mode

```bash
# Launch interactive mode
node backend/cli.js

# Follow the menu prompts to:
# - Create users
# - Manage accounts
# - Perform transactions
# - View history
```

---

## Error Handling

The CLI provides clear error messages:

- ✗ Failed operations show error messages
- ✓ Successful operations show confirmation
- Input validation prevents invalid data
- Database connection errors are clearly displayed

---

## Tips

1. **Use interactive mode** for first-time users or complex operations
2. **Use direct commands** for automation and scripts
3. **Check help** with `-h` flag for command syntax
4. **API calls** require authentication tokens (get via `/api/auth/login`)
5. **All amounts** are in decimal format (e.g., `100.50`)

---

## Troubleshooting

### Database Connection Errors
- Ensure PostgreSQL is running: `docker-compose ps`
- Check `.env` file configuration
- Verify database exists

### Authentication Errors (API)
- Ensure JWT token is valid
- Token expires after 24 hours
- Re-login to get a new token

### Command Not Found
- Ensure you're in the project root directory
- Use `node backend/cli.js` not just `cli.js`

