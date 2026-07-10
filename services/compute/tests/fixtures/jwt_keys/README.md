# Synthetic JWT Keys

These RSA keys are synthetic, test-only fixtures for compute service contract tests.
They let Python mint RS256 tokens with the same public-key verification contract as
the Node/Express issuer without starting the full Express authentication flow.

Never replace these files with production, customer, environment, or developer
private keys. Production JWT keys must be provided only through runtime secret
configuration.
