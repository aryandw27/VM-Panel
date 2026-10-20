# SiliconHost VM Panel - No-KVM Docker Container

Run **SiliconHost VM Panel** inside a Docker environment with **No-KVM Mode (QEMU TCG Software Emulation)**. This mode does not require `/dev/kvm`; QEMU software emulation is substantially slower than hardware virtualization.

---

## Quick Start: No-KVM Container

### 1. Configure secrets

Create a local `.env` file before starting the stack. Use a unique panel secret, a MongoDB password containing only URL-safe characters, and a strong administrator password:

```bash
cat > .env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
MONGO_ROOT_PASSWORD=$(openssl rand -hex 24)
ADMIN_USER=admin
ADMIN_EMAIL=admin@siliconhost.local
ADMIN_PASSWORD=$(openssl rand -hex 24)
EOF
chmod 600 .env
```

Do not commit `.env` to Git or reuse these secrets elsewhere.

### 2. Start Container with Docker Compose
```bash
docker compose up -d --build
```

### 3. Access the Panel
- **Web UI**: [http://localhost:3001](http://localhost:3001)
- **REST API**: [http://localhost:3002/api](http://localhost:3002/api)
- The administrator username and password are the values set in `.env`.

---

## Standalone No-KVM Docker Command

```bash
# Build the Docker image
docker build -t siliconhost-vm-panel .

# Run container in No-KVM Mode (no /dev/kvm required)
source .env
docker network create siliconhost-panel
docker volume create siliconhost-mongodb-data
docker run -d \
  --name siliconhost-mongodb \
  --network siliconhost-panel \
  --restart unless-stopped \
  -e MONGO_INITDB_ROOT_USERNAME=admin \
  -e MONGO_INITDB_ROOT_PASSWORD="$MONGO_ROOT_PASSWORD" \
  -v siliconhost-mongodb-data:/data/db \
  mongo:latest
docker run -d \
  --name siliconhost-vm-panel \
  --network siliconhost-panel \
  --restart unless-stopped \
  -e NO_KVM=1 \
  -e JWT_SECRET="$JWT_SECRET" \
  -e MONGO_URI="mongodb://admin:${MONGO_ROOT_PASSWORD}@siliconhost-mongodb:27017/vpanel?authSource=admin" \
  -e ADMIN_USER="${ADMIN_USER:-admin}" \
  -e ADMIN_EMAIL="${ADMIN_EMAIL:-admin@siliconhost.local}" \
  -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD first}" \
  -p 3001:3001 \
  -p 3002:3002 \
  -p 25501-25600:25501-25600 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/vms:/app/vms \
  -v $(pwd)/uploads:/app/uploads \
  siliconhost-vm-panel
```

---

## How No-KVM Mode Works
- **Engine**: QEMU uses `-machine type=pc,accel=tcg` and `-cpu qemu64`.
- **Port Forwarding**: Automatic user-space networking with port forwarding for SSH, VNC, and Agent.
- **Compatibility**: Works on any Linux/Mac/Windows host even if nested virtualization is disabled.
