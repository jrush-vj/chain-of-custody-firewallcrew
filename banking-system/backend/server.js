import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { swaggerSpec } from './config/swagger.js';
import { connectDB, closeDB } from './config/database.js';
import { createTables } from './database/migrations.js';
import { requestLogger } from './middleware/logger.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import transactionRoutes from './routes/transactions.js';
import scheduledPaymentRoutes from './routes/scheduledPayments.js';
import paymentPortalRoutes from './routes/paymentPortal.js';
import { sanitizeRequest } from './middleware/sanitize.js';
import { startWitnessOutboxRetry } from './services/witnessedTransactions.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Middleware
app.set('trust proxy', 1); // honor X-Forwarded-* headers when running behind reverse proxies
app.disable('x-powered-by');
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'same-origin' }
  })
);
app.use(
  cors({
    // Without an explicit allowlist only same-origin requests (no Origin header) get CORS
    // headers in production; reflecting every origin with credentials would let any site
    // drive a logged-in user's session.
    origin: allowedOrigins.length ? allowedOrigins : !isProduction,
    credentials: true
  })
);

// Health check (before the rate limiter so container/deploy probes never consume the budget)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(sanitizeRequest);
app.use(requestLogger);
app.use(apiLimiter);

// Swagger Documentation (off in production unless explicitly enabled)
if (!isProduction || process.env.ENABLE_API_DOCS === 'true') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/scheduled-payments', scheduledPaymentRoutes);
// The tokenless portal credits any IBAN without authentication; keep it off in production
// unless explicitly enabled for a demo.
if (!isProduction || process.env.ENABLE_PAYMENT_PORTAL === 'true') {
  app.use('/send-payment', paymentPortalRoutes);
}

// Root metadata
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Banking System API is running',
    docs: '/api-docs',
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const startServer = async () => {
  try {
    await connectDB();
    await createTables();
    startWitnessOutboxRetry();
    
    // Check if SSL is enabled
    if (process.env.USE_SSL === 'true') {
      try {
        const { createHTTPServer } = await import('./config/ssl.js');
        const httpsServer = createHTTPServer(app, PORT);
        
        if (httpsServer) {
          console.log(`HTTPS server running on port ${PORT}`);
          console.log(`API Documentation available at https://localhost:${PORT}/api-docs`);
        } else {
          // Fallback to HTTP if SSL setup fails
          app.listen(PORT, () => {
            console.log(`Server running on port ${PORT} (HTTP - SSL setup failed)`);
            console.log(`API Documentation available at http://localhost:${PORT}/api-docs`);
          });
        }
      } catch (sslError) {
        console.warn('SSL setup failed, using HTTP:', sslError.message);
        app.listen(PORT, () => {
          console.log(`Server running on port ${PORT} (HTTP)`);
          console.log(`API Documentation available at http://localhost:${PORT}/api-docs`);
        });
      }
    } else {
      app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`API Documentation available at http://localhost:${PORT}/api-docs`);
      });
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await closeDB();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  await closeDB();
  process.exit(0);
});

startServer();


