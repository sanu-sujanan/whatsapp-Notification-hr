# n8n Render Deployment (Without Docker)

Deploy n8n directly to Render without Docker.

## Build Command
npm install

## Start Command
npm start

## Required Environment Variables

### N8N_ENCRYPTION_KEY (REQUIRED)
n8n requires an encryption key to function properly. Set this in Render's environment variables.

**Generate a key:**
```bash
openssl rand -base64 32
```

**Or use Node.js:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Add this as `N8N_ENCRYPTION_KEY` in your Render service environment variables.

## Default Login
Username: admin  
Password: admin123

