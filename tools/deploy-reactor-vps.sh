#!/bin/bash
# Deploy reactor call-line + EARTH keeper to VPS under PM2
# Run from EARTH/tools/: bash deploy-reactor-vps.sh
set -e

VPS="vps"
REMOTE="/root/reactor-keeper"
LOCAL="$(dirname "$0")"

echo "=== Deploying reactor keepers to VPS ==="

# Create remote directory
ssh "$VPS" "mkdir -p $REMOTE/reports"

# Copy scripts
echo "Copying reactor-call-line.js..."
scp "$LOCAL/reactor-call-line.js" "$VPS:$REMOTE/"

echo "Copying EARTH keeper.js..."
scp "$LOCAL/keeper.js" "$VPS:$REMOTE/"

# Copy node dependencies (ethers is needed)
echo "Copying package.json..."
scp "$LOCAL/package.json" "$VPS:$REMOTE/" 2>/dev/null || echo '{"dependencies":{"ethers":"^6.16.0","dotenv":"^16.0.0"}}' | ssh "$VPS" "cat > $REMOTE/package.json"

# Create .env from baseling-api .env (same wallet/supabase keys)
echo "Linking env from baseling-api..."
ssh "$VPS" "ln -sf /root/baseling-api/.env $REMOTE/.env"

# Install deps on VPS
echo "Installing dependencies..."
ssh "$VPS" "cd $REMOTE && npm install --production 2>&1 | tail -3"

# Create ecosystem.config.js for PM2
echo "Creating PM2 config..."
ssh "$VPS" "cat > $REMOTE/ecosystem.config.js" << 'EOF'
module.exports = {
  apps: [{
    name: 'reactor-callline',
    script: 'reactor-call-line.js',
    cwd: '/root/reactor-keeper',
    // Override dotenv path to local .env
    env: { DOTENV_PATH: '/root/reactor-keeper/.env' },
    autorestart: true,
    max_memory_restart: '256M',
    error_file: '/root/reactor-keeper/logs/callline-error.log',
    out_file: '/root/reactor-keeper/logs/callline-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 5000,
    max_restarts: 20,
  }, {
    name: 'earth-keeper',
    script: 'keeper.js',
    args: '--loop',
    cwd: '/root/reactor-keeper',
    env: { DOTENV_PATH: '/root/reactor-keeper/.env' },
    autorestart: true,
    max_memory_restart: '128M',
    error_file: '/root/reactor-keeper/logs/earth-error.log',
    out_file: '/root/reactor-keeper/logs/earth-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 5000,
    max_restarts: 20,
  }]
};
EOF

# Create logs dir
ssh "$VPS" "mkdir -p $REMOTE/logs"

# Start PM2
echo "Starting PM2 processes..."
ssh "$VPS" "cd $REMOTE && pm2 start ecosystem.config.js && pm2 save"

echo ""
echo "=== Reactor VPS deployment complete ==="
echo "Check status: ssh vps 'pm2 list'"
echo "Check logs: ssh vps 'pm2 logs reactor-callline --lines 20'"
echo ""
echo "IMPORTANT: The call-line reads .env from /root/baseling-api/.env (symlinked)."
echo "It needs: AGENT_PRIVATE_KEY or KEEPER_PRIVATE_KEY, SUPABASE_URL, SUPABASE_KEY"
