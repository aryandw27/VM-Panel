# Recovering an uncertain VM operation

AI VM lifecycle execution is globally disabled unless the panel process is explicitly configured with `AI_VM_LIFECYCLE_ENABLED=1`. Keep it unset or set to `0` until isolated QEMU validation and release review are complete. Per-user tool preferences remain an additional requirement; the global switch does not alter saved preferences.

An uncertain operation is deliberately quarantined. Lease expiry is not proof that QEMU or a disk utility stopped. Do not delete lock documents directly and do not clear a quarantine merely because the VM appears stopped in the dashboard.

## Manual administrator reconciliation

1. Identify the VM and operation ID from the protected operation history. Do not copy provider keys, environment values, or raw logs into the evidence.
2. Stop the panel application service and verify that it is inactive. The reconciliation command refuses to run while `panel.service` is active; this prevents a live panel worker from continuing an operation during review.
3. On the same host, as an OS account whose matching panel account has administrator role, run:

   ```sh
   node scripts/reconcile-vm-operation.js --vm-id <VM_ID> --operation-id <OPERATION_UUID> --confirm-quiescent
   ```

4. The command independently checks the exact uncertain operation and lock, scans `/proc` for matching `qemu-system` and `qemu-img` processes under that VM's disk and backup directories, and checks the VM PID file against the expected QEMU executable and PID-file path. If any process is active or evidence is unavailable, it refuses and retains the quarantine.
5. On a successful reconciliation, an audit event records the administrator, operation, timestamp, and machine-checked evidence. The operation remains historically `uncertain`; only its lock is released. Restart the panel service and inspect the VM before requesting a new action.

This procedure cannot see QEMU processes or disk operations on another host, independent host-level control plane, or storage service. Reconcile only on the host that owns the VM and storage. If those ownership boundaries cannot be established, retain the quarantine and escalate to the virtualization administrator.

The panel lock only coordinates code paths using its MongoDB coordinator. It does not serialize changes made outside the panel.
