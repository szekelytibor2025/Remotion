#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 24.04 LTS one-shot setup for Kessey Records Visualizer API
# Run as root or with sudo. Idempotent; safe to re-run.

REPO_DIR="${REPO_DIR:-/opt/kessey-records-visualizer}"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-4}"

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root or with sudo." >&2
  exit 1
fi

echo "==> Updating apt"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

echo "==> Installing base packages"
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg ufw fail2ban git nginx certbot python3-certbot-nginx \
  htop tmux build-essential

echo "==> Installing Docker engine"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  ARCH=$(dpkg --print-architecture)
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable docker
  systemctl start docker
else
  echo "Docker already installed, skipping"
fi

echo "==> Configuring swap (${SWAP_SIZE_GB}G)"
if [[ ! -f /swapfile ]]; then
  fallocate -l "${SWAP_SIZE_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
else
  echo "Swap file already exists, skipping"
fi

echo "==> Tuning sysctl for low-memory swap usage"
cat > /etc/sysctl.d/99-kessey.conf <<EOF
vm.swappiness=20
vm.vfs_cache_pressure=50
EOF
sysctl -p /etc/sysctl.d/99-kessey.conf >/dev/null

echo "==> Configuring UFW firewall"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Enabling fail2ban"
systemctl enable fail2ban
systemctl restart fail2ban

if [[ ! -d "$REPO_DIR" ]]; then
  echo "==> Repository not found at $REPO_DIR"
  echo "    Clone it manually:"
  echo "      git clone <your-repo> $REPO_DIR"
  echo "    Then run this script again, or proceed manually with:"
  echo "      cd $REPO_DIR && cp api/.env.example api/.env && \\"
  echo "      vim api/.env  # fill in SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_HMAC_SECRET"
  echo "      docker compose up -d --build"
fi

echo ""
echo "==> Setup complete."
echo ""
echo "Next steps:"
echo "  1. Place repository at $REPO_DIR"
echo "  2. Configure $REPO_DIR/api/.env (copy from .env.example)"
echo "  3. cd $REPO_DIR && docker compose up -d --build"
echo "  4. Create an API key:"
echo "       docker compose exec api npm run create-key -- 'kessey-dashboard'"
echo "  5. Configure Nginx reverse proxy + Let's Encrypt:"
echo "       certbot --nginx -d render.your-domain.com"
echo ""
