// IMPORTANT: Set all n8n environment variables BEFORE any imports
// Configure n8n for Render deployment
const PORT = process.env.PORT || 5678;
const N8N_INTERNAL_PORT = parseInt(PORT) + 1; // Use PORT + 1 to avoid conflicts

// Set n8n to use internal port BEFORE any imports
// IMPORTANT: n8n must use a DIFFERENT port than our Express server
// Save the original PORT for our Express server
const EXPRESS_PORT = PORT;
// Configure n8n to use a different port
// CRITICAL: n8n should NOT use the main PORT - it should use N8N_PORT
process.env.N8N_PORT = N8N_INTERNAL_PORT.toString();
process.env.N8N_HOST = '0.0.0.0';
// Explicitly unset PORT for n8n to prevent it from using the main port
// We'll restore it just for Express
const originalPort = process.env.PORT;
delete process.env.PORT; // Remove PORT so n8n can't use it

// Disable queue mode - run in main process mode to avoid Task Broker entirely
// This is the simplest solution for single-instance deployments
process.env.EXECUTIONS_PROCESS = 'main';
process.env.N8N_QUEUE_BULL_REDIS_HOST = '';

// Disable Task Broker completely for single-instance deployment
// Disable runners to prevent Task Broker from starting
process.env.N8N_RUNNERS_ENABLED = 'false';
// Set Task Broker port to a high number to avoid conflicts (even if disabled)
process.env.N8N_RUNNERS_BROKER_PORT = '56800';
// Also set the task broker URI to prevent it from trying to bind
process.env.N8N_RUNNERS_TASK_BROKER_URI = '';

// n8n Encryption Key - REQUIRED for n8n to start properly
// If not set in environment, generate a warning but don't fail
if (!process.env.N8N_ENCRYPTION_KEY) {
  console.warn('⚠️  WARNING: N8N_ENCRYPTION_KEY is not set!');
  console.warn('⚠️  n8n requires an encryption key to function properly.');
  console.warn('⚠️  Set N8N_ENCRYPTION_KEY in Render environment variables.');
  console.warn('⚠️  Generate one with: openssl rand -base64 32');
  // Set a temporary key so n8n can at least start (but credentials won't persist)
  process.env.N8N_ENCRYPTION_KEY = 'temp-key-change-in-production-' + Date.now();
}

// Now import after environment is configured
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

// Configure n8n base URL if needed
if (process.env.RENDER_EXTERNAL_URL) {
  const url = new URL(process.env.RENDER_EXTERNAL_URL);
  process.env.N8N_HOST = url.hostname;
  process.env.N8N_PROTOCOL = url.protocol.replace(':', '');
}

const app = express();

let n8nReady = false;
let proxyMiddleware = null;
const isProxyReady = () => Boolean(n8nReady && proxyMiddleware);

// Add request logging middleware to debug
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Express received request`);
  next();
});

// Add JSON body parser
app.use(express.json());

// Root route handler: proxy to n8n UI when ready, otherwise expose startup status
app.all('/', (req, res, next) => {
  if (req.method === 'HEAD') {
    console.log('Root HEAD request - reporting status', n8nReady ? 'ready' : 'starting');
    res.setHeader('x-n8n-ready', n8nReady ? 'true' : 'false');
    return res.sendStatus(200);
  }

  if (isProxyReady()) {
    console.log('Root route proxying to n8n');
    return proxyMiddleware(req, res, next);
  }

  console.log('Root route hit before n8n is ready', req.method, req.path); // Debug log
  res.status(200).json({
    status: 'starting',
    message: 'n8n is starting up, please retry shortly',
    service: 'n8n',
    ready: n8nReady
  });
});

// Health check endpoint
app.all('/health', (req, res) => {
  console.log('Health route hit!', req.method, req.path); // Debug log
  res.status(200).json({ 
    status: 'healthy',
    service: 'hr-notification',
    timestamp: new Date().toISOString()
  });
});

// Test route to verify Express is working
app.all('/test', (req, res) => {
  res.status(200).json({ message: 'Express routes are working!' });
});

// 404 handler for unknown routes (but this should come AFTER proxy setup)
// This will be added after proxy is configured

// Restore PORT for Express (n8n should already be configured with N8N_PORT)
process.env.PORT = originalPort || EXPRESS_PORT.toString();

// Start Express server on Render's PORT FIRST
// This MUST start and bind to the port before n8n starts
app.listen(EXPRESS_PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`Express server is running on port ${EXPRESS_PORT}`);
  console.log(`Root endpoint: http://localhost:${EXPRESS_PORT}/`);
  console.log(`Health endpoint: http://localhost:${EXPRESS_PORT}/health`);
  console.log(`Test endpoint: http://localhost:${EXPRESS_PORT}/test`);
  console.log(`n8n will be proxied from http://localhost:${EXPRESS_PORT}/`);
  console.log(`n8n internal port: ${N8N_INTERNAL_PORT}`);
  console.log(`========================================`);
  
  // Now that Express server is bound to the port, start n8n
  // NOTE: Express root route will work even if n8n fails to start
  console.log('Starting n8n on port', N8N_INTERNAL_PORT, '...');
  console.log('N8N_ENCRYPTION_KEY is', process.env.N8N_ENCRYPTION_KEY ? 'set' : 'NOT SET');
  
  import('n8n/bin/n8n').then(() => {
    console.log('✅ n8n started successfully on internal port', N8N_INTERNAL_PORT);
    
    // Wait a bit for n8n to fully initialize, then set up proxy
    setTimeout(() => {
      // Create proxy middleware that explicitly excludes root and health
      proxyMiddleware = createProxyMiddleware({
        target: `http://localhost:${N8N_INTERNAL_PORT}`,
        changeOrigin: true,
        ws: true, // Enable websocket proxying for n8n
        logLevel: 'info',
        onError: (err, req, res) => {
          // If n8n isn't ready yet, return a helpful message
          if (err.code === 'ECONNREFUSED') {
            res.status(503).json({
              status: 'error',
              message: 'n8n is starting up, please wait a moment and try again'
            });
          } else {
            res.status(500).json({
              status: 'error',
              message: 'Proxy error',
              error: err.message
            });
          }
        }
      });

      app.use((req, res, next) => {
        const path = req.path;
        
        // NEVER proxy routes handled by Express
        if (path === '/' || path === '/health' || path === '/test') {
          console.log('Skipping proxy for:', path, '- handled by Express routes');
          return next(); // Let Express route handlers handle these
        }
        
        if (!isProxyReady()) {
          console.log('n8n not ready yet - delaying proxy for:', path);
          return res.status(503).json({
            status: 'error',
            message: 'n8n is still starting up, please try again shortly'
          });
        }

        console.log('Proxying to n8n:', path);
        return proxyMiddleware(req, res, next);
      });
      
      n8nReady = true;
      console.log('Proxy middleware configured - n8n UI requests now served through Express');
    }, 3000); // Wait 3 seconds for n8n to fully start
  }).catch((error) => {
    console.error('❌ Error starting n8n:', error);
    console.error('⚠️  Express server is still running and root route should work');
    console.error('⚠️  Check N8N_ENCRYPTION_KEY and other n8n configuration');
    // Don't exit - Express server should continue serving root route
  });
});
