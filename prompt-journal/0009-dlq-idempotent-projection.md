# 0009 - DLQ and Idempotent Projection

- **_Asked:_** Protect the D1 stage-transition projection queue with a DLQ and make duplicate deliveries safe end to end.

- **_Produced:_** Kept the projection queue redrive policy on the source queue and added consumer helpers to alert on DLQ depth and redrive held messages back to the source queue after a fix. Reworked the projection consumer dedupe to reuse the Module 4 idempotency key helpers and Redis store shape.

- **_Accepted / Rejected:_** ACCEPTED: `maxReceiveCount = 3`, a 7-day projection dedupe TTL, and local stdout/stderr alerts for DLQ depth. REJECTED: `maxReceiveCount = 1`, because one transient receive failure should not immediately dead-letter a valid event. REJECTED: a new projection-specific dedupe store.

- **_Why:_** Three receives gives transient failures a small retry window while still moving poison records to the DLQ quickly in local development. A 7-day dedupe TTL covers normal SQS redelivery and manual redrive windows without retaining projection keys indefinitely. Local alerts are enough for this module and make non-empty DLQ depth visible instead of silently accumulating failed records.

- **_Idempotency model:_** The consumer claims the event idempotency key with one Redis Lua operation: check the reused replay key and set the reused lock key atomically. Duplicate concurrent deliveries cannot both project, and a failed projection releases the lock without recording the replay key so SQS can retry or redrive.
