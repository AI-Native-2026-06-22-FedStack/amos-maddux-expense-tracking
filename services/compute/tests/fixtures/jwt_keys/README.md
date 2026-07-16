# Synthetic JWT Key Fixtures

Committed RSA key files are intentionally not stored here. Compute service tests
generate synthetic RS256 key pairs at runtime so broad repository scans do not
find committed signing key values.

Never add production, customer, environment, or developer private keys to this
directory. Production JWT keys must be provided only through runtime secret
configuration.
