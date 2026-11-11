import { dockerProxyCommand } from "./docker-proxy.js";

// `node dist/docker-proxy.js`: the judged Docker socket, a process of its own so the orchestrator never holds Docker's.
const code = dockerProxyCommand();
if (code !== null) process.exit(code);
