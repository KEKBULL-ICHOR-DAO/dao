# chain stub

Reviewed local replacement for the npm package named `chain`.

`@meteora-ag/cp-amm-sdk@1.4.6` lists `chain@^0.4.0` as a runtime dependency.
That name is ambiguous on the registry. This workspace does **not** install it.

This package has:

- no `scripts`
- no `exports`
- no `main`
- no JavaScript files

npm `overrides` in `ichor/client/package.json` rewrite every transitive
`chain` request to `file:./vendor/chain-stub`. If the Meteora SDK actually
`import`s or `require`s `chain`, module resolution fails. That is safer than
executing unreviewed registry code.

Do not add an index file, re-export, or compatibility shim here without a
lead review of the real `chain` tarball.
