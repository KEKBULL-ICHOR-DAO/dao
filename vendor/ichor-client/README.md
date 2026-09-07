# @kekbull/ichor-client

Unsigned TypeScript builders and account parsers for ICHOR. No send path. No key material.

Discriminators are pinned SHA-256 prefixes so the module stays browser-safe. Live mint owner, decimals, and Config fields are read from chain.

Approved direct pins: `@solana/web3.js@1.98.4`, `@solana/spl-token@0.4.15`, `@realms-today/spl-governance@0.3.33`, `@meteora-ag/cp-amm-sdk@1.4.6`, `bn.js@5.2.5`.

`overrides.chain` points at `vendor/chain-stub` so the ambiguous npm name `chain` is never installed.
