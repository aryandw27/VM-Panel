'use strict';

const { shellQuote } = require('./util');

function assertCredential(value, label) {
  const text = String(value || '');
  if (!text || /[\r\n\0]/.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

/**
 * Runs inside an already-started container via the runtime's exec facility.
 * Keeps sshd on PID 1's process group; the container entrypoint stays alive.
 */
function sshProvisionScript({ username, password }) {
  const user = assertCredential(username || 'root', 'SSH username');
  const pass = assertCredential(password, 'SSH password');
  const userLiteral = shellQuote(user);
  const passLiteral = shellQuote(pass);
  const rootBlock = user === 'root'
    ? `echo ${shellQuote(`root:${pass}`)} | chpasswd\n`
    : `echo ${shellQuote(`root:${pass}`)} | chpasswd\n` +
      `id -u ${userLiteral} >/dev/null 2>&1 || useradd -m -s /bin/sh ${userLiteral} 2>/dev/null || adduser -D -s /bin/sh ${userLiteral}\n` +
      `echo ${shellQuote(`${user}:${pass}`)} | chpasswd\n` +
      `(command -v usermod >/dev/null 2>&1 && usermod -aG sudo ${userLiteral}) || (command -v addgroup >/dev/null 2>&1 && addgroup ${userLiteral} wheel) || true\n` +
      `(command -v sudo >/dev/null 2>&1 && echo ${shellQuote(`${user} ALL=(ALL) NOPASSWD:ALL`)} > /etc/sudoers.d/90-vpanel) || true\n`;

  return `set -e
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq openssh-server sudo >/dev/null 2>&1 || apt-get install -y openssh-server sudo
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache openssh sudo >/dev/null 2>&1 || apk add --no-cache openssh sudo
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y openssh-server sudo >/dev/null 2>&1 || dnf install -y openssh-server sudo
elif command -v yum >/dev/null 2>&1; then
  yum install -y openssh-server sudo >/dev/null 2>&1 || yum install -y openssh-server sudo
else
  echo "No supported package manager found for openssh-server" >&2
  exit 42
fi
${rootBlock}
mkdir -p /etc/ssh /run/sshd
for key in PermitRootLogin PasswordAuthentication KbdInteractiveAuthentication UsePAM; do
  sed -i "s/^#\\?$key .*/$key yes/" /etc/ssh/sshd_config 2>/dev/null || true
  grep -qi "^$key " /etc/ssh/sshd_config 2>/dev/null || echo "$key yes" >> /etc/ssh/sshd_config
done
ssh-keygen -A >/dev/null 2>&1 || true
systemctl enable ssh >/dev/null 2>&1 || systemctl enable sshd >/dev/null 2>&1 || true
pkill -x sshd >/dev/null 2>&1 || true
/usr/sbin/sshd -D >/var/log/vpanel-sshd.log 2>&1 &
sleep 1
(command -v sshd >/dev/null 2>&1 && sshd -t) || true
echo "vpanel-ssh-ready"
`;
}

function indentedBlock(text) {
  return String(text || '').split('\n').map((line) => `    ${line}`).join('\n');
}

/**
 * cloud-init is the only reliable way to inject credentials into an Incus VM
 * before its guest agent is available.
 */
function cloudInitUserData({ hostname, username, password }) {
  const host = assertCredential(hostname || 'vpanel', 'hostname');
  const user = assertCredential(username || 'root', 'SSH username');
  const pass = assertCredential(password, 'SSH password');
  const rootList = `    root:${pass}`;
  const userList = user === 'root' ? '' : `    ${user}:${pass}\n`;
  return `#cloud-config
hostname: ${host}
ssh_pwauth: true
disable_root: false
chpasswd:
  expire: false
  list: |
${rootList}
${userList.replace(/\n$/, '')}
users:
  - name: ${user}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    plain_text_passwd: ${pass}
write_files:
  - path: /etc/ssh/sshd_config.d/60-vpanel.conf
    owner: root:root
    permissions: '0644'
    content: |
${indentedBlock('PermitRootLogin yes\nPasswordAuthentication yes\nKbdInteractiveAuthentication yes')}
runcmd:
  - systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true
`;
}

module.exports = { sshProvisionScript, cloudInitUserData };
