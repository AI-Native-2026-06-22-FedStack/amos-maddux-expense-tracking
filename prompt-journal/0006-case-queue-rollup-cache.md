# 0006 — Case Queue Rollup Cache

- **_Asked:_** Add Redis cache-aside caching in front of the DynamoDB-backed Case Queue rollup read model.

- **_Produced:_** Added a tenant-scoped Case Queue rollup cache that checks Redis before reading DynamoDB, writes cached rollups with `EX 60`, invalidates the tenant rollup after stage changes, and uses a short Redis `SET ... PX ... NX` rebuild lock so concurrent requests do not stampede DynamoDB when a hot key expires. Added tests for cache hits, write-side invalidation, and concurrent rebuild single-flight behavior.

- **_Accepted / Rejected:_** ACCEPTED: Use a Redis lock to protect the read-through rebuild path. REJECTED: Rely only on jittered TTLs or stale-while-revalidate for stampede protection.

- **_Why:_** The 60-second TTL matches the dashboard's tolerance for roughly a minute of staleness and the eventually-consistent aggregate read choice in ADR-0008. A much shorter TTL would drive avoidable DynamoDB traffic for a dashboard that does not need second-by-second aggregate freshness, while a longer TTL would make missed invalidations more visible to Finance Admins and Department Managers. A Redis lock gives a cross-process single-flight mechanism for expired hot keys. Jittered TTLs can spread expirations across keys, but jitter alone does not prevent concurrent requests from all missing the same hot key at once. Stale-while-revalidate can reduce latency, but this task requires the next read after invalidation to be fresh, so the cache uses explicit invalidation plus a short rebuild lock.
