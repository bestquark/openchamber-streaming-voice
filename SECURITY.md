# Security and privacy

The companion binds its gateway, OpenChamber and OpenCode to `127.0.0.1`. Its gateway rejects foreign Host/Origin headers and cross-site browser requests, including WebSocket upgrades. Do not expose these local ports to a LAN, reverse proxy or tunnel: this is not a multi-user server. Other trusted processes under your local account can reach loopback services.

Speech credentials remain in the local Node process and outbound provider requests; the companion does not embed them in browser assets. Requests use configured fixed destinations, reject redirects and have payload bounds. A stored OpenCode provider key is reused only for that exact API base URL. An optional language adapter at a different origin requires explicit authentication configuration. Keep credentials/config outside this checkout. Never include keys, logs, recordings, project files or browser storage in a public issue.

Each person should use their own credentials and local OS account/data. Revoke compromised credentials at the provider. This companion does not enroll devices in a hosted OpenChamber instance, enable remote access or use a hosted workspace API. It disables OpenCode conversation sharing in the launched process.

OpenCode tools run with the local user's filesystem privileges and permission rules. A project directory is not a sandbox. Existing user-configured providers and MCP tools retain their own network behavior. Prompts, audio and selected file contents are processed by the configured providers, whose operators may observe and log requests. Local history storage does not imply privacy from the inference/speech provider.

Report sensitive vulnerabilities through GitHub's private vulnerability reporting for this repository. Use fake tokens and empty projects in reproductions. Do not publish real credentials or private endpoint details in issues.
