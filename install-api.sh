#!/usr/bin/env bash
# =============================================================================
# Kessey Records — Remotion API install script
# Target: Ubuntu 25.04 (Noble/Plucky)
# Domain: video.api.kesseyrecords.hu
# Services: Redis + API (Express) + Worker (BullMQ) behind Nginx + SSL
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Config — edit before running
# ---------------------------------------------------------------------------
DOMAIN="video.api.kesseyrecords.hu"
EMAIL="tiborgaming2021@gmail.com"          # Let's Encrypt contact email
REPO_URL="https://github.com/szekelytibor2025/Remotion.git"  # GitHub repo
REPO_DIR="/opt/kessey-api"                 # local path where repo is cloned
COMPOSE_FILE="$REPO_DIR/docker-compose.yml"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[ OK ]\033[0m  $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
die()   { echo -e "\033[1;31m[FAIL]\033[0m  $*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || die "Run this script as root (sudo bash install-api.sh)"
}

# ---------------------------------------------------------------------------
# 1. System update
# ---------------------------------------------------------------------------
step_update() {
  info "Updating system packages…"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
  apt-get install -y -qq \
    curl wget git ca-certificates gnupg lsb-release \
    ufw certbot python3-certbot-nginx nginx
  ok "System up to date"
}

# ---------------------------------------------------------------------------
# 2. Docker Engine
# ---------------------------------------------------------------------------
step_docker() {
  if command -v docker &>/dev/null; then
    ok "Docker already installed ($(docker --version))"
    return
  fi
  info "Installing Docker Engine…"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
  ok "Docker installed ($(docker --version))"
}

# ---------------------------------------------------------------------------
# 3. Clone / update repo
# ---------------------------------------------------------------------------
step_repo() {
  if [[ -d "$REPO_DIR/.git" ]]; then
    info "Repo already exists — pulling latest…"
    git -C "$REPO_DIR" pull --ff-only
  else
    info "Cloning $REPO_URL → $REPO_DIR…"
    git clone "$REPO_URL" "$REPO_DIR"
  fi
  ok "Repo ready at $REPO_DIR"
}

# ---------------------------------------------------------------------------
# 4. Environment file
# ---------------------------------------------------------------------------
step_env() {
  local env_file="$REPO_DIR/api/.env"
  if [[ -f "$env_file" ]]; then
    ok ".env already exists — skipping (edit manually if needed)"
    return
  fi

  info "Creating $env_file template…"
  cat > "$env_file" <<'EOF'
# ── Server ────────────────────────────────────────────────────────────────
PORT=3001
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

# ── Redis (set by docker-compose via environment: block) ──────────────────
REDIS_URL=redis://redis:6379

# ── SQLite ────────────────────────────────────────────────────────────────
SQLITE_PATH=/app/data/api.db

# ── Remotion ──────────────────────────────────────────────────────────────
REMOTION_BUNDLE_DIR=/app/remotion
REMOTION_COMPOSITION_ID=Rings
REMOTION_CONCURRENCY=2

# ── Supabase ──────────────────────────────────────────────────────────────
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
SUPABASE_VIDEO_BUCKET=videos

# ── Webhook HMAC ──────────────────────────────────────────────────────────
WEBHOOK_HMAC_SECRET=CHANGE_ME_MIN_16_CHARS

# ── Work dir ──────────────────────────────────────────────────────────────
WORK_DIR=/app/work
EOF

  warn "Fill in $env_file before starting services!"
  ok ".env template created"
}

# ---------------------------------------------------------------------------
# 5. Firewall (UFW)
# ---------------------------------------------------------------------------
step_firewall() {
  info "Configuring UFW firewall…"
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  ok "Firewall active (SSH + 80 + 443 allowed)"
}

# ---------------------------------------------------------------------------
# 6. Nginx — HTTP proxy (before SSL)
# ---------------------------------------------------------------------------
step_nginx_http() {
  info "Writing Nginx config (HTTP only — before SSL)…"
  cat > /etc/nginx/sites-available/kessey-api <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

  ln -sf /etc/nginx/sites-available/kessey-api \
         /etc/nginx/sites-enabled/kessey-api
  rm -f /etc/nginx/sites-enabled/default

  mkdir -p /var/www/certbot
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  ok "Nginx HTTP config active"
}

# ---------------------------------------------------------------------------
# 7. SSL certificate (Let's Encrypt via Certbot)
# ---------------------------------------------------------------------------
step_ssl() {
  if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
    ok "SSL certificate already exists for $DOMAIN"
    return
  fi

  info "Obtaining SSL certificate for $DOMAIN…"
  certbot certonly --nginx \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"
  ok "SSL certificate obtained"
}

# ---------------------------------------------------------------------------
# 8. Nginx — HTTPS reverse proxy
# ---------------------------------------------------------------------------
step_nginx_https() {
  info "Writing Nginx HTTPS config…"
  cat > /etc/nginx/sites-available/kessey-api <<EOF
# ── Rate limiting ─────────────────────────────────────────────────────────
limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=30r/m;

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN;

    # ── SSL ───────────────────────────────────────────────────────────────
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_tickets off;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    # ── HSTS ──────────────────────────────────────────────────────────────
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # ── Security headers ──────────────────────────────────────────────────
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;

    # ── Client body (video render requests can have large JSON) ───────────
    client_max_body_size 10M;

    # ── Gzip ──────────────────────────────────────────────────────────────
    gzip on;
    gzip_types application/json text/plain;

    # ── Health endpoint — no rate limit ───────────────────────────────────
    location = /health {
        proxy_pass         http://127.0.0.1:3001;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 10s;
    }

    # ── API — rate limited ────────────────────────────────────────────────
    location /api/ {
        limit_req zone=api_limit burst=10 nodelay;
        limit_req_status 429;

        proxy_pass         http://127.0.0.1:3001;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        # Render jobs can take a while to queue
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # ── Deny everything else ──────────────────────────────────────────────
    location / {
        return 404;
    }
}
EOF

  nginx -t
  systemctl reload nginx
  ok "Nginx HTTPS config active"
}

# ---------------------------------------------------------------------------
# 9. Certbot auto-renewal systemd timer
# ---------------------------------------------------------------------------
step_certbot_renewal() {
  info "Ensuring Certbot auto-renewal is active…"
  # certbot package ships the timer on Ubuntu; just make sure it's enabled
  systemctl enable --now certbot.timer 2>/dev/null || true

  # Hook: reload nginx after renewal
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/nginx-reload.sh <<'EOF'
#!/bin/bash
systemctl reload nginx
EOF
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/nginx-reload.sh
  ok "Certbot auto-renewal active"
}

# ---------------------------------------------------------------------------
# 10. Build & start Docker containers
# ---------------------------------------------------------------------------
step_containers() {
  info "Building and starting Docker containers…"
  cd "$REPO_DIR"
  docker compose -f docker-compose.yml pull --quiet || true
  docker compose -f docker-compose.yml build --no-cache
  docker compose -f docker-compose.yml up -d
  ok "Containers started"
}

# ---------------------------------------------------------------------------
# 11. Smoke test
# ---------------------------------------------------------------------------
step_smoke() {
  info "Waiting for API to be ready…"
  local max=45 i=0
  until curl -sf http://127.0.0.1:3001/health > /dev/null 2>&1; do
    i=$((i+1))
    if [[ $i -ge $max ]]; then
      warn "API health check timed out — check logs:"
      docker compose --project-directory "$REPO_DIR" logs api
      return 1
    fi
    sleep 2
  done
  ok "API is up — http://127.0.0.1:3001/health"

  info "Testing HTTPS endpoint…"
  if curl -sf "https://$DOMAIN/health" > /dev/null 2>&1; then
    ok "HTTPS is working: https://$DOMAIN/health"
  else
    warn "HTTPS test failed — DNS may not have propagated yet."
    warn "Once DNS is set, verify with: curl https://$DOMAIN/health"
  fi
}

# ---------------------------------------------------------------------------
# 12. Print next steps
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║         Kessey Records — Remotion API install complete           ║"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  Domain  : https://$DOMAIN               ║"
  echo "║  Health  : https://$DOMAIN/health        ║"
  echo "║  API     : https://$DOMAIN/api/v1/render ║"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  Useful commands:                                                ║"
  echo "║  docker compose --project-directory $REPO_DIR logs -f api    ║"
  echo "║  docker compose --project-directory $REPO_DIR logs -f worker ║"
  echo "║  docker compose --project-directory $REPO_DIR ps             ║"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  Next steps:                                                     ║"
  echo "║  1. Edit $REPO_DIR/api/.env with real secrets     ║"
  echo "║  2. Restart: docker compose --project-directory $REPO_DIR up -d   ║"
  echo "║  3. Create API key:                                              ║"
  echo "║     docker compose --project-directory $REPO_DIR exec api          ║"
  echo "║       node dist/scripts/create-key.js             ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  require_root
  step_update
  step_docker
  step_repo
  step_env
  step_firewall
  step_nginx_http
  step_ssl
  step_nginx_https
  step_certbot_renewal
  step_containers
  step_smoke
  print_summary
}

main "$@"
