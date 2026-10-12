import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create HTTPS server with SSL certificates
export const createHTTPServer = (app, port = 5000) => {
  if (process.env.USE_SSL === 'true') {
    const certPath = process.env.SSL_CERT || path.join(__dirname, '../../ssl/cert.pem');
    const keyPath = process.env.SSL_KEY || path.join(__dirname, '../../ssl/key.pem');
    
    try {
      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        const options = {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath)
        };
        
        return https.createServer(options, app).listen(port, () => {
          console.log(`HTTPS server running on port ${port}`);
        });
      } else {
        console.warn('SSL certificate files not found at:', certPath, keyPath);
        console.warn('Falling back to HTTP. See SSL_SETUP.md for instructions.');
        return null;
      }
    } catch (error) {
      console.warn('Error loading SSL certificates:', error.message);
      console.warn('Falling back to HTTP');
      return null;
    }
  }
  
  return null;
};

