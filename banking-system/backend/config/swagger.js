import swaggerJsdoc from 'swagger-jsdoc';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const buildServerList = () => {
  const protocol = process.env.USE_SSL === 'true' ? 'https' : 'http';
  const port = process.env.PORT || 5000;
  const defaultLocal = `${protocol}://localhost:${port}`;
  const configuredUrls =
    process.env.SWAGGER_SERVER_URLS || process.env.SWAGGER_SERVER_URL || '';

  const servers = [
    {
      url: '/',
      description: 'Current host (auto-detected)'
    }
  ];

  const addServer = (url, description) => {
    if (url && !servers.some((server) => server.url === url)) {
      servers.push({ url, description });
    }
  };

  addServer(defaultLocal, 'Local development');

  configuredUrls
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
    .forEach((url, idx) => addServer(url, `Configured server ${idx + 1}`));

  return servers;
};

const apiDescription = `Complete banking system REST API with JWT authentication, accounts, and transactions.

## Authentication Instructions

1. **Obtain a JWT token**
   - Call \`POST /api/auth/login\` with your \`email\` and \`password\`.
   - Or call \`POST /api/auth/register\` to create a new user and receive a token immediately.

2. **Authorize every protected request**
   - Click the **Authorize** button in Swagger UI and paste your token prefixed with \`Bearer \`.
   - Alternatively send the HTTP header: \`Authorization: Bearer <token>\`.
   - All \`/api/*\` routes, except register/login, require this bearer token. Two-factor authentication is not needed.

3. **Token lifetime**
   - Tokens remain valid for 24 hours. Request a new one by logging in again when you receive a 401.`;

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Banking System API',
      version: '1.0.0',
      description: apiDescription,
      contact: {
        name: 'API Support'
      }
    },
    servers: buildServerList(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT token. Get it by calling /api/auth/login or /api/auth/register'
        }
      }
    }
  },
  apis: [path.join(__dirname, '..', 'routes', '*.js'), path.join(__dirname, '..', 'server.js')]
};

export const swaggerSpec = swaggerJsdoc(options);

