# Afrikoba Deployment Script
# 1. Pull latest changes (if git enabled)
# 2. Install dependencies
# 3. Build frontend
# 4. Restart service

echo "Starting Afrikoba Global deployment..."

# Install dependencies
npm install

# Apply any pending database migrations (idempotent)
node scripts/runMigrations.js

# Build frontend
npm run build

# Restart service (using pm2 if available, else start)
if command -v pm2 &> /dev/null; then
    pm2 restart afrikoba-global || pm2 start src/server.js --name afrikoba-global
else
    echo "PM2 not found. Please start the server manually using 'npm start'"
fi

echo "Deployment finished."
