# AI assistant: architecture, setup, and release notes

## Existing panel architecture and integration map

The panel is a Node.js 18+ application using Express, EJS server-rendered pages, MongoDB collections, JWT/cookie authentication, and QEMU virtual machines. User-facing routes are mounted from `src/routes/webUser.js`; global layout and account navigation live in `views/partials`; `src/lib/db.js` initializes MongoDB collections and indexes. Existing VM ownership checks and QEMU status/log functions live in `src/services/vmService.js`.

AI integration points added here:

- `src/services/aiSecurity.js`: AES-256-GCM encryption, provider error mapping, and custom endpoint SSRF checks.
- `src/services/aiService.js`: provider adapters, per-user credentials/preferences/history, conversation handling, and a central read-only VM tool registry.
- `src/routes/ai.js`: authenticated, account-scoped AI API.
- `src/lib/db.js`: MongoDB collection/index initialization (the panel's existing migration convention).
- `views/user/aiSettings.ejs`, `views/partials/sidebar.ejs`, and `public/{css,js}/ai-*`: provider settings and global chat drawer.
- `src/services/aiLogService.js`: retains local QEMU log heuristics only; no provider is called during diagnostics.

## Data and endpoint model

MongoDB collections added by the normal startup initializer:

- `ai_credentials`: user ID, provider, nickname, key hint, model, endpoint, active selection, timestamps, and AES-GCM ciphertext/IV/tag.
- `ai_preferences`: per-user tool permissions.
- `ai_conversations` and `ai_messages`: owned conversation history.
- `ai_events`: safe provider/model/status/latency/tool metadata. No prompts, keys, authorization headers, response bodies, or estimated charges are stored here.

All endpoints are mounted under `/api/ai` and require the panel's existing authenticated user. Credential, conversation, and tool-permission queries are scoped to that user ID on the server. AI operations are disabled during account impersonation.

The settings page and drawer use these endpoint groups: `providers`, `credentials` (create/list/test/activate/delete), `tools` (read/update), `history`, `conversations` (create/list/read/rename/delete), and `conversations/:id/messages` (server-sent progress events followed by the final response). Provider response text currently arrives at completion; tool and provider activity is sent as progress events.

## BYOK and encryption setup

Set `AI_CREDENTIALS_ENCRYPTION_KEY` in the panel process environment before saving credentials. It must be a persistent secret containing exactly 32 random bytes encoded as base64 or 64 hexadecimal characters. Generate a new value with:

```sh
openssl rand -base64 32
```

Store it in the server's protected environment configuration (for example, the existing `.env`) and restart the panel. Never commit or publish the value. If this key is lost, saved credentials cannot be decrypted. Key rotation requires decrypting and re-encrypting every credential in a controlled migration; changing the environment value alone will make existing keys unusable.

Users select a provider and model, can retrieve the provider's current model list, save a key, test it, and explicitly activate the saved configuration. OpenAI, Anthropic, OpenRouter, and OpenAI-compatible HTTPS endpoints are supported. A small curated list is shown until discovery is requested; provider access and model availability can change independently. Compatible endpoints must resolve exclusively to public addresses; the request pins the checked DNS result and rejects redirects.

The product policy is: “Bring your own API key. No panel-imposed AI usage quotas. Your provider's pricing, quotas, and rate limits apply.” The application does not meter or bill model usage, rotate keys, retry timed-out provider calls, or fall back to panel-funded inference.

## Tools currently available

| Tool | Data returned | Authorization |
| --- | --- | --- |
| `list_deployments` | Name, ID, power status, CPU and memory allocation for accessible VMs | Current user's own and shared VM records; permission checked server-side |
| `inspect_deployment` | VM metadata and live resource statistics | `vmService.canAccess` check on the requested VM |
| `read_deployment_logs` | Bounded tail excerpt from that VM's QEMU/serial logs | Ownership/access check; file paths derived from the authorized VM ID |

These tools are read-only, configurable per user, and disabled server-side when their permission is off. Tool rounds and output are bounded. No high-impact operation is currently exposed, so there are no model-driven write approvals in this increment.

## Security notes

- Credentials are encrypted with AES-256-GCM before MongoDB persistence and are only decrypted in server-side provider request code.
- Credential API responses contain a masked hint, never ciphertext or plaintext.
- Provider error bodies are not echoed to the user; normalized errors avoid reflecting sensitive provider text.
- The tool registry receives untrusted VM log content only as tool output. System instructions tell the model not to follow instructions found in logs or other retrieved data.
- Custom endpoint requests require HTTPS, reject local/private/link-local DNS results, pin the resolved address, use the hostname for TLS verification, and reject redirects.
- There is no application-level AI message quota or internal AI-credit system. Timeouts and bounded payload/tool output are reliability controls.

## Verification

Run `npm run test:ai` for the isolated security unit tests. `node --check` can validate the changed server and browser JavaScript without requiring MongoDB. The existing build script initializes MongoDB and creates runtime directories; the existing full regression scripts make changes to the configured database and host integrations. Only run those suites against a dedicated disposable test environment.

## Current scope and follow-up work

This panel manages virtual machines rather than application containers. The implemented tool set therefore covers QEMU VM inventory, status, resource statistics, and boot logs. On the VM console, local QEMU/kernel signature detection can offer an “Ask AI to investigate” action. The user must accept; only a short signature label and VM ID are sent in the initial prompt, and the assistant can then request bounded boot-log data through its authorized read-only tool. The detector does not invoke a provider or transmit logs by itself. Application-specific signatures such as Node package errors or Discord intents do not apply to this QEMU panel. Deployment file edits, guest environment-variable management, package operations, backup restore, command execution, documentation search, and community templates are not wired into this assistant. Secret values are not returned by any AI tool. The UI streams provider/tool activity; provider-generated text is delivered when the provider response completes rather than token-by-token.

## Safe rollout and rollback

Before rollout, take the project's existing source/configuration backup and ensure the encryption key is durably backed up. Add the code changes without replacing `.env`, then set the encryption key in the deployment environment and restart through the panel's normal process manager. Verify the account settings page, test a provider key, explicitly activate it, ask a basic question, and confirm an authorized read-only VM lookup. Roll back by restoring the pre-change source archive and restarting the prior application version. Retain the new encryption key while any encrypted credential records remain; deleting the key makes those records unrecoverable.
