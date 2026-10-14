# Swagger UI Authentication Guide

## Problem: Getting 403 "Invalid or expired token" Error

If you're seeing this error, you're likely trying to use the JWT_SECRET from your `.env` file. **That's not correct!** You need to get a JWT **token** by logging in first.

## Step-by-Step Guide

### Step 1: Get a JWT Token

You need to authenticate first to get a token. You have two options:

#### Option A: Register a New User

1. In Swagger UI, find the **Authentication** section
2. Click on `POST /api/auth/register`
3. Click "Try it out"
4. Enter your details:
   ```json
   {
     "username": "testuser",
     "email": "test@example.com",
     "password": "password123"
   }
   ```
5. Click "Execute"
6. In the response, **copy the `token` value** (it's a long string)

#### Option B: Login with Existing User

1. In Swagger UI, find the **Authentication** section
2. Click on `POST /api/auth/login`
3. Click "Try it out"
4. Enter your credentials:
   ```json
   {
     "email": "john@example.com",
     "password": "password123"
   }
   ```
   (Use test accounts from seed data if available)
5. Click "Execute"
6. In the response, **copy the `token` value**

### Step 2: Authorize in Swagger UI

1. Look for the **🔒 Authorize** button at the top right of Swagger UI
2. Click it
3. In the "Value" field, paste **ONLY the token** (without "Bearer " prefix)
   - ✅ Correct: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
   - ❌ Wrong: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
   - ❌ Wrong: `your-super-secret-jwt-key-change-this-in-production`
4. Click "Authorize"
5. Click "Close"

### Step 3: Use Protected Endpoints

Now you can use any endpoint that requires authentication:
- `GET /api/accounts` - List your accounts
- `POST /api/accounts` - Create an account
- `GET /api/transactions` - View transaction history
- etc.

## Visual Guide

```
┌─────────────────────────────────────────┐
│  Banking System API          🔒 Authorize │  ← Click here!
└─────────────────────────────────────────┘

After clicking Authorize:
┌─────────────────────────────────────────┐
│ Available authorizations               │
│                                         │
│ bearerAuth (http, Bearer)              │
│ Value: [paste token here]              │  ← Paste token
│                                         │
│  [Authorize]  [Close]                  │
└─────────────────────────────────────────┘
```

## Example Token Response

When you login/register, you'll get a response like this:

```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJqb2huQGV4YW1wbGUuY29tIiwiaWF0IjoxNjk5OTk5OTk5LCJleHAiOjE3MDAwODU5OTl9.abc123def456...",
  "user": {
    "id": 1,
    "username": "john_doe",
    "email": "john@example.com"
  }
}
```

**Copy the entire `token` string** (it's very long, make sure you get it all).


## Troubleshooting

### Still getting 403?

1. **Check token is complete:** Tokens are long (200+ chars). Make sure you copied it all.
2. **Check server is using same JWT_SECRET:** Restart server if you changed `.env`
3. **Token expired:** Get a new token by logging in again
4. **Check Swagger shows "Authorized":** Look for a green checkmark next to the lock icon

### Server not reading JWT_SECRET?

1. Check `.env` file exists in project root
2. Check `JWT_SECRET` is set in `.env`
3. Restart the server after changing `.env`
4. Check server logs for connection errors

## Quick Test Script

You can also test authentication with cURL:

```bash
# 1. Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john@example.com","password":"password123"}'

# 2. Copy the token from response, then:
curl -X GET http://localhost:5000/api/accounts \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Need Help?

- Check server logs for detailed error messages
- Verify `.env` file has correct `JWT_SECRET`
- Ensure server was restarted after `.env` changes
- Try logging in again to get a fresh token

