# KEKBULL DAO UI

Holder SPA for [dao.kekbull.com](https://dao.kekbull.com). Wallet Standard only. No keys in this repo.

Mainnet pins ship in `public/deployment.json` (Realm, Governance, native treasury, ICHOR, KEKBULL). Convert stays paused until a later public unpause. Fee split on KEKBULL is 75% DAO treasury / 25% creator.

`@kekbull/ichor-client` is vendored at `vendor/ichor-client` so this tree builds without the private monorepo layout.

Signing is allowed only on `dao.kekbull.com` or loopback. Other hosts fail closed.

Related: [ichor](https://github.com/KEKBULL-ICHOR-DAO/ichor), [kekbull-governance](https://github.com/KEKBULL-ICHOR-DAO/kekbull-governance), [website](https://github.com/KEKBULL-ICHOR-DAO/website).
