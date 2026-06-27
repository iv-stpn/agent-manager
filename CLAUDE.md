# Project Rules

## Debugging containerized services

When a Docker/compose service fails to become ready (health check timeout, "did not become ready", port not responding, etc.), **always pull the container logs yourself before anything else** — do not hand the user a script or ask them to check.

```bash
docker compose -f <compose-file> logs --tail=200 <service>
docker compose -f <compose-file> ps
```

The root cause is almost always visible in the logs: a startup crash, a syntax/import error, a missing env var, or a binding failure. A `restart: unless-stopped` policy will make `ps` show "running" during restart windows, so a crash-loop can masquerade as a healthy container — only the logs reveal it.

Do this *during* investigation, not after suggesting reproduction steps. Checking logs is faster than writing a repro.
