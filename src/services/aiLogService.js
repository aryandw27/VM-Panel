const vmService = require('./vmService');

class AiLogService {
  


  async diagnoseLog(logText = '') {
    if (!logText || !logText.trim()) {
      return {
        status: 'healthy',
        severity: 'INFO',
        title: 'No Boot Log Recorded',
        category: 'System',
        confidence: 100,
        explanation: 'There is no console or boot output to analyze yet. Start the virtual machine to capture boot messages.',
        suggested_fixes: ['Power on the virtual machine from the control panel.'],
        terminal_commands: [],
        provider: 'offline-rule-engine',
      };
    }

    const text = String(logText);

    
    const offlineResult = this.analyzeWithExpertRules(text);
    if (offlineResult) {
      return offlineResult;
    }

    
    return {
      status: 'healthy',
      severity: 'INFO',
      title: 'Normal Operating Conditions',
      category: 'System',
      confidence: 90,
      explanation: 'No critical kernel panics, hardware virtualization faults, or disk corruption errors were detected in the log stream.',
      suggested_fixes: [
        'If the machine is unresponsive, check if SSH is listening on the assigned port.',
        'Review guest firewall rules inside the guest OS.',
      ],
      terminal_commands: ['dmesg -T | tail -n 50'],
      provider: 'offline-rule-engine',
    };
  }

  


  async diagnoseVm(vm) {
    const logContent = vmService.readBootLog(vm);
    const diagnosis = await this.diagnoseLog(logContent);
    diagnosis.vm = {
      id: vm.id,
      name: vm.name,
      status: vm.status,
      memory: vm.memory,
      cpus: vm.cpus,
    };
    return diagnosis;
  }

  


  analyzeWithExpertRules(text) {
    
    if (/kernel panic/i.test(text) || /unable to mount root fs/i.test(text) || /not syncing: VFS/i.test(text)) {
      const match = text.match(/unable to mount root fs[^\n]*/i) || text.match(/kernel panic[^\n]*/i);
      return {
        status: 'issue_detected',
        severity: 'CRITICAL',
        title: 'Kernel Panic: Root Filesystem Failure',
        category: 'Kernel / Storage',
        confidence: 99,
        snippet: match ? match[0] : 'Kernel panic - not syncing: VFS: Unable to mount root fs',
        explanation:
          'The Linux kernel initiated boot execution but failed to locate or mount the designated root partition. This happens when the root UUID in the bootloader does not match the disk image, or the virtio-blk driver is missing from the initial RAM disk (initrd).',
        suggested_fixes: [
          'Verify the virtual disk has a valid MBR or GPT partition scheme.',
          'Verify cloud-init user-data generated a valid filesystem table (fstab).',
          'Ensure the disk driver interface in QEMU is set to virtio-blk or ide.',
        ],
        terminal_commands: [
          'qemu-img check <vm_disk_path>',
          'fdisk -l <vm_disk_path>',
        ],
        provider: 'offline-rule-engine',
      };
    }

    
    if (/could not access kvm/i.test(text) || /failed to initialize kvm/i.test(text) || /permission denied.*\/dev\/kvm/i.test(text) || /kvm_init_vcpu failed/i.test(text)) {
      const match = text.match(/.*kvm.*permission denied.*/i) || text.match(/failed to initialize kvm.*/i);
      return {
        status: 'issue_detected',
        severity: 'CRITICAL',
        title: 'Hardware Acceleration: KVM Permission Denied',
        category: 'Host Virtualization',
        confidence: 98,
        snippet: match ? match[0] : 'Could not access KVM kernel module: Permission denied',
        explanation:
          'QEMU attempted to utilize hardware virtualization acceleration via /dev/kvm, but access was rejected due to host device node permissions or missing nested virtualization support.',
        suggested_fixes: [
          'Grant appropriate permissions to the host /dev/kvm device node.',
          'Add the process user to the host kvm group.',
          'If running inside a container, enable nested KVM device passthrough (/dev/kvm).',
        ],
        terminal_commands: [
          'sudo chmod 666 /dev/kvm',
          'sudo usermod -aG kvm $USER',
          'ls -l /dev/kvm',
        ],
        provider: 'offline-rule-engine',
      };
    }

    
    if (/no space left on device/i.test(text) || /disk quota exceeded/i.test(text) || /write error.*full/i.test(text)) {
      return {
        status: 'issue_detected',
        severity: 'CRITICAL',
        title: 'Storage Exhaustion: No Space Left on Device',
        category: 'Storage',
        confidence: 97,
        snippet: 'write error: No space left on device',
        explanation:
          'The host filesystem storage pool hosting the VM disk images has reached 100% capacity, preventing QEMU from expanding copy-on-write (qcow2) blocks or writing log and PID files.',
        suggested_fixes: [
          'Free unused space on the host node storage volume.',
          'Clean old backups and ISO images in /admin/storage.',
          'Resize the virtual machine disk from Server Settings.',
        ],
        terminal_commands: [
          'df -h',
          'du -sh /var/lib/vpanel/vms/*',
        ],
        provider: 'offline-rule-engine',
      };
    }

    
    if (/image is corrupt/i.test(text) || /qemu-img: could not open/i.test(text) || /unsupported qcow2 version/i.test(text) || /invalid disk image/i.test(text)) {
      return {
        status: 'issue_detected',
        severity: 'CRITICAL',
        title: 'Disk Integrity: Corrupt QCOW2 Image',
        category: 'Storage',
        confidence: 96,
        snippet: 'qemu: Image is corrupt or header unrecognized',
        explanation:
          'The VM disk file header or cluster allocation table is invalid. This typically occurs if a download or snapshot was forcefully terminated mid-write.',
        suggested_fixes: [
          'Run qemu-img repair to recover damaged metadata clusters.',
          'Restore the virtual machine from the most recent snapshot or backup.',
        ],
        terminal_commands: [
          'qemu-img check -r all <vm_disk_path>',
          'qemu-img info <vm_disk_path>',
        ],
        provider: 'offline-rule-engine',
      };
    }

    
    if (/out of memory: kill process/i.test(text) || /oom-killer/i.test(text) || /total-vm:.*anon-rss:/i.test(text)) {
      return {
        status: 'issue_detected',
        severity: 'CRITICAL',
        title: 'Memory Starvation: Linux OOM Killer Triggered',
        category: 'Memory / Resource Quota',
        confidence: 95,
        snippet: 'Out of memory: Kill process (qemu-system-x86_64)',
        explanation:
          'The operating system kernel terminated the process because available physical memory and swap were completely depleted.',
        suggested_fixes: [
          'Increase the allocated RAM for this virtual machine in Server Settings.',
          'Inspect inside the guest for memory leaks or configure swap space.',
        ],
        terminal_commands: [
          'free -m',
          'sudo dmesg -T | grep -i oom',
        ],
        provider: 'offline-rule-engine',
      };
    }

    
    if (/address already in use/i.test(text) || /eaddrinuse/i.test(text) || /failed to bind socket/i.test(text)) {
      return {
        status: 'issue_detected',
        severity: 'WARNING',
        title: 'Networking: Port Collision (EADDRINUSE)',
        category: 'Network',
        confidence: 94,
        snippet: 'Failed to bind socket: Address already in use',
        explanation:
          'QEMU was unable to bind the requested VNC, SSH, or TAP network port because another service or previous zombie VM process is still occupying the port.',
        suggested_fixes: [
          'Check for lingering background QEMU processes using the same port.',
          'Change the VNC or Forwarded Port in VM Configuration.',
        ],
        terminal_commands: [
          'sudo ss -tulpn | grep <port>',
          'sudo fuser -k <port>/tcp',
        ],
        provider: 'offline-rule-engine',
      };
    }

    
    if (/failed to start[^\n]*/i.test(text) || /dependency failed for[^\n]*/i.test(text)) {
      const match = text.match(/failed to start[^\n]*/i) || text.match(/dependency failed for[^\n]*/i);
      return {
        status: 'issue_detected',
        severity: 'WARNING',
        title: 'Guest OS: Systemd Unit Failure',
        category: 'Operating System',
        confidence: 88,
        snippet: match ? match[0] : 'Failed to start system service',
        explanation:
          'A systemd service or daemon failed during boot. The kernel is functional, but user-space services may be degraded.',
        suggested_fixes: [
          'Log in via noVNC console or emergency shell to review failed units.',
          'Run journalctl inside the guest to check specific service output.',
        ],
        terminal_commands: [
          'systemctl --failed',
          'journalctl -xeu <service_name>',
        ],
        provider: 'offline-rule-engine',
      };
    }

    
    if (/cloud-init.*error/i.test(text) || /datasourcenocloud/i.test(text) || /cloud-init.*failed/i.test(text)) {
      return {
        status: 'issue_detected',
        severity: 'WARNING',
        title: 'Provisioning: Cloud-Init Initialization Error',
        category: 'Cloud-Init / Provisioning',
        confidence: 90,
        snippet: 'Cloud-init initialization encountered syntax or network errors',
        explanation:
          'The initial configuration wizard encountered errors parsing the user-data YAML or setting the administrative password.',
        suggested_fixes: [
          'Validate cloud-init YAML syntax for improper indentation or unescaped characters.',
          'Reboot the VM to allow cloud-init to finish provisioning scripts.',
        ],
        terminal_commands: [
          'cloud-init status --long',
          'cat /var/log/cloud-init-output.log',
        ],
        provider: 'offline-rule-engine',
      };
    }

    return null;
  }

}

module.exports = new AiLogService();
