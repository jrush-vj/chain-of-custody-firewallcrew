# Quick Setup Guide

## Prerequisites
- Node.js (v14 or higher)
- Docker and Docker Compose
- npm

## Step-by-Step Setup

1. **Install dependencies:**
   ```bash
   npm install
   cd frontend && npm install && cd ..
   ```

2. **Start PostgreSQL with Docker:**
   ```bash
   npm run docker:up
   # or
   docker-compose up -d
   ```
   
   This will start a PostgreSQL container on port 5432.

3. **Configure environment variables:**
   
   Create a `.env` file in the root directory:
   ```
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=bankingsystem
   DB_USER=postgres
   DB_PASSWORD=postgres
   JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
   PORT=5000
   NODE_ENV=development
   ```

4. **Run database migrations:**
   ```bash
   npm run migrate
   ```

5. **(Optional) Seed test data:**
   ```bash
   npm run seed
   ```
   
   This creates test users:
   - Email: `john@example.com`, Password: `password123`
   - Email: `jane@example.com`, Password: `password123`
   - Email: `bob@example.com`, Password: `password123`

6. **Start the backend server:**
   ```bash
   npm start
   # or for development with auto-reload:
   npm run dev
   ```
   
   The API will be available at `http://localhost:5000`
   Swagger documentation: `http://localhost:5000/api-docs`

7. **Start the frontend (in a new terminal):**
   ```bash
   npm run client
   ```
   
   The frontend will be available at `http://localhost:3000`

## Docker Commands

- Start PostgreSQL: `npm run docker:up` or `docker-compose up -d`
- Stop PostgreSQL: `npm run docker:down` or `docker-compose down`
- View logs: `docker-compose logs -f postgres`
- Check status: `docker-compose ps`

## Troubleshooting

### Database Connection Issues

#### Error: "Connection refused" or "ECONNREFUSED"
- Make sure Docker is running
- Check if PostgreSQL container is running: `docker-compose ps`
- Start the container: `npm run docker:up`
- Wait a few seconds for PostgreSQL to fully start

#### Error: "database does not exist"
- The database is created automatically by Docker Compose
- If it doesn't exist, you can create it manually:
  ```bash
  docker exec -it banking-postgres psql -U postgres -c "CREATE DATABASE bankingsystem;"
  ```

#### Reset Database
- Stop containers: `docker-compose down -v` (removes volumes)
- Start again: `docker-compose up -d`
- Run migrations: `npm run migrate`

### PowerShell Execution Policy
If you encounter script execution errors in PowerShell:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Or for a more permanent solution (requires admin):
```powershell
Set-ExecutionPolicy RemoteSigned
```

## Create Self-Signed SSL Certifcate
```bash
openssl req -x509 -nodes -days 365 -subj "/CN=localhost" -newkey rsa:2048 -sha256 -keyout key.pem -out cert.pem
```

## Next Steps
- Log in to the frontend with one of the test accounts
- Create new accounts
- Make transactions
- View transaction history
