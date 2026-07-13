# 0005 — Expense Write Rate Limit

- **_Asked:_** Add Redis-backed per-tenant rate limiting and graduated slow-down for authenticated Expense Report writes.

- **_Produced:_** Added the dependency and validated configuration foundation for Redis-backed Expense Report write limiting, then implemented a Redis/Lua token-bucket hard limiter keyed by tenant. Added `express-slow-down` before the hard limiter, wired the limiter stack only to `POST /expense-reports`, and added Redis-backed integration verification for the per-tenant cap, tenant isolation, graduated delay, refill behavior, and shared limits across app instances.

- **_Accepted / Rejected:_** ACCEPTED: Use a token bucket for the hard write limiter. REJECTED: Use fixed-window behavior for the hard limiter.

- **_Why:_** Token bucket handles bursts better than fixed-window while still enforcing a sustained per-tenant request rate. `POST /expense-reports` is limited because it is the expensive authenticated write path. `GET /expense-reports/:id` is not limited in this task. `express-slow-down` runs before the hard limiter so latency rises before a `429` response. `rate-limit-redis` backs the Redis slow-down counter, while Redis/Lua backs the hard limiter because `rate-limit-redis` is fixed-window.
