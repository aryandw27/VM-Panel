#!/usr/bin/env bash
set -e

echo "========================================="
echo "  Starting SiliconHost VM Panel Container  "
echo "========================================="


if [ "$NO_KVM" = "1" ] || [ "$NOKVM" = "1" ] || [ ! -e "/dev/kvm" ]; then
  echo "[vpanel] Operating Mode: No-KVM (QEMU TCG Software Emulation)"
  export NO_KVM=1
else
  echo "[vpanel] Operating Mode: KVM Hardware Accelerated (/dev/kvm)"
  export NO_KVM=0
fi


mkdir -p /app/data /app/vms /app/uploads/logo /app/uploads/favicon /app/uploads/background /app/uploads/music /app/uploads/backup /app/storage/logs


node scripts/build.js

if [ -f "/app/scripts/createuser.js" ]; then
  node -e "
    const { initDb, closeDb, collections } = require('./src/lib/db');
    const auth = require('./src/services/authService');
    (async () => {
      await initDb();
      const count = await collections.users.countDocuments();
      if (count === 0) {
        if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
          throw new Error('Set ADMIN_PASSWORD to a value of at least 12 characters before first startup.');
        }
        console.log('[SiliconHost] Creating the configured administrator account.');
        const u = await auth.createUser({
          username: process.env.ADMIN_USER || 'admin',
          email: process.env.ADMIN_EMAIL || 'admin@siliconhost.local',
          password: process.env.ADMIN_PASSWORD,
          name: 'Administrator',
          role: 'admin',
          verified: 1
        });
        await collections.users.updateOne({ id: u.id }, { $set: { root_admin: 1 } });
      }
      await closeDb();
    })().catch((error) => { console.error(error); process.exit(1); });
  "
fi

echo "[SiliconHost] Ready on port 3001 (Web) and port 3002 (API)"
exec "$@"
