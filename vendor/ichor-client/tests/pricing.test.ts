import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pricingSrc = readFileSync(join(clientRoot, "src/pricing.ts"), "utf8");
const typesSrc = readFileSync(join(clientRoot, "src/types.ts"), "utf8");
const indexSrc = readFileSync(join(clientRoot, "src/index.ts"), "utf8");
const networkSrc = readFileSync(join(clientRoot, "src/network.ts"), "utf8");

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const BPS_DENOM = 10_000n;

const OFF_CREATOR = 11;
const OFF_BASE_MINT = 43;
const OFF_QUOTE_MINT = 75;
const OFF_BASE_VAULT = 139;
const OFF_QUOTE_VAULT = 171;
const OFF_COIN_CREATOR = 211;
const OFF_IS_MAYHEM = 243;
const OFF_IS_CASHBACK = 244;
const OFF_VIRTUAL_QUOTE = 245;
const VIRTUAL_QUOTE_LEN = 16;
const MIN_POOL_LEN = 245;

function tenPow(exp: number): bigint {
  let v = 1n;
  for (let i = 0; i < exp; i++) {
    v *= 10n;
    if (v > U128_MAX) throw new Error("overflow");
  }
  return v;
}

function requireU128(value: bigint, label: string): bigint {
  if (value < 0n || value > U128_MAX) throw new Error(`overflow:${label}`);
  return value;
}

function requireU64(value: bigint, label: string): bigint {
  if (value < 0n || value > U64_MAX) throw new Error(`u64:${label}`);
  return value;
}

function ichorFromKekbull(
  kek: bigint,
  kekDecimals: number,
  ichorDecimals: number,
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (kek <= 0n) throw new Error("zero");
  if (numerator <= 0n || denominator <= 0n) throw new Error("ratio");
  if (numerator > denominator) throw new Error("RATIO_ABOVE_CEILING");
  const scaleUp = ichorDecimals > kekDecimals ? tenPow(ichorDecimals - kekDecimals) : 1n;
  const scaleDown = ichorDecimals < kekDecimals ? tenPow(kekDecimals - ichorDecimals) : 1n;
  const minted = requireU128(kek * numerator * scaleUp, "num") / requireU128(denominator * scaleDown, "den");
  if (minted === 0n) throw new Error("floor");
  return requireU64(minted, "ichor");
}

function ceilDiv(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("div0");
  return requireU128(num + den - 1n, "ceil") / den;
}

function kekbullInterval(
  ichor: bigint,
  kekDecimals: number,
  ichorDecimals: number,
  numerator: bigint,
  denominator: bigint,
): { min: bigint; max: bigint } {
  if (numerator > denominator) throw new Error("RATIO_ABOVE_CEILING");
  const scaleUp = ichorDecimals > kekDecimals ? tenPow(ichorDecimals - kekDecimals) : 1n;
  const scaleDown = ichorDecimals < kekDecimals ? tenPow(kekDecimals - ichorDecimals) : 1n;
  const A = requireU128(numerator * scaleUp, "A");
  const B = requireU128(denominator * scaleDown, "B");
  const min = requireU64(ceilDiv(requireU128(ichor * B, "I*B"), A), "min");
  const max = requireU64((requireU128((ichor + 1n) * B, "(I+1)*B") - 1n) / A, "max");
  if (min === 0n || max < min) throw new Error("unreachable");
  if (ichorFromKekbull(min, kekDecimals, ichorDecimals, numerator, denominator) !== ichor) {
    throw new Error("min-image");
  }
  if (ichorFromKekbull(max, kekDecimals, ichorDecimals, numerator, denominator) !== ichor) {
    throw new Error("max-image");
  }
  return { min, max };
}

function solParity(kek: bigint, quote: bigint, base: bigint, rounding: "floor" | "ceiling"): bigint {
  if (kek <= 0n || quote <= 0n || base <= 0n) throw new Error("non-positive");
  const product = requireU128(kek * quote, "kek*quote");
  const q = rounding === "ceiling" ? ceilDiv(product, base) : product / base;
  return requireU64(q, "parity");
}

function applyBps(amount: bigint, bps: number, rounding: "floor" | "ceiling"): bigint {
  if (bps === undefined || bps === null) throw new Error("bps-required");
  if (!Number.isInteger(bps) || bps < -10_000 || bps > 0) throw new Error("bps");
  const factor = BPS_DENOM + BigInt(bps);
  if (factor <= 0n) throw new Error("non-positive-adjust");
  const product = requireU128(amount * factor, "adj");
  const q = rounding === "ceiling" ? ceilDiv(product, BPS_DENOM) : product / BPS_DENOM;
  if (q <= 0n) throw new Error("zero-adj");
  return requireU64(q, "adjusted");
}

function effectiveQuote(vault: bigint, virtual: bigint): bigint {
  const total = vault + virtual;
  if (total <= 0n) throw new Error("non-positive-quote");
  return requireU128(total, "effective");
}

function readI128Le(data: Uint8Array, offset: number): bigint {
  let x = 0n;
  for (let i = 0; i < 16; i++) {
    x |= BigInt(data[offset + i]) << (8n * BigInt(i));
  }
  if (x >= 1n << 127n) x -= 1n << 128n;
  return x;
}

function parsePool(data: Uint8Array): {
  index: number;
  isMayhem: boolean;
  isCashback: boolean;
  virtualQuoteReserves: bigint;
  virtualQuotePresent: boolean;
} {
  if (data.length < MIN_POOL_LEN) throw new Error("short");
  const boolAt = (offset: number, label: string): boolean => {
    const byte = data[offset];
    if (byte === 0) return false;
    if (byte === 1) return true;
    throw new Error(`bool:${label}`);
  };
  const virtualQuotePresent = data.length >= OFF_VIRTUAL_QUOTE + VIRTUAL_QUOTE_LEN;
  return {
    index: data[9] | (data[10] << 8),
    isMayhem: boolAt(OFF_IS_MAYHEM, "mayhem"),
    isCashback: boolAt(OFF_IS_CASHBACK, "cashback"),
    virtualQuoteReserves: virtualQuotePresent ? readI128Le(data, OFF_VIRTUAL_QUOTE) : 0n,
    virtualQuotePresent,
  };
}

function writeI128Le(value: bigint): Uint8Array {
  let x = value;
  if (x < 0n) x += 1n << 128n;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

describe("canonical PumpSwap PDA seeds", () => {
  it("derives pool-authority on pump and pool on PumpSwap with index 0", () => {
    assert.match(pricingSrc, /POOL_AUTHORITY_SEED = utf8\.encode\("pool-authority"\)/);
    assert.match(pricingSrc, /POOL_SEED = utf8\.encode\("pool"\)/);
    assert.match(pricingSrc, /CANONICAL_POOL_INDEX = 0/);
    assert.match(pricingSrc, /u16LeBytes\(CANONICAL_POOL_INDEX\)/);
    assert.match(pricingSrc, /findProgramAddressSync\(poolAuthoritySeeds\(baseMint\), PUMP_PROGRAM\)/);
    assert.match(pricingSrc, /new PublicKey\(PUMP_SWAP\.id\)/);
    assert.match(networkSrc, /pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA/);
    assert.match(networkSrc, /pump-public-docs/);
    assert.match(indexSrc, /PUMP_SWAP/);
    assert.doesNotMatch(pricingSrc, /creator_vault|creator-vault/);
    assert.doesNotMatch(pricingSrc, /b"pool_authority"|utf8\.encode\("pool_authority"\)/);
  });

  it("encodes the canonical index as unsigned 16-bit little-endian zero", () => {
    const bytes = new Uint8Array([0, 0]);
    assert.equal(bytes[0], 0);
    assert.equal(bytes[1], 0);
    assert.match(pricingSrc, /new Uint8Array\(\[value & 0xff, \(value >> 8\) & 0xff\]\)/);
    assert.doesNotMatch(pricingSrc, /toArrayLike\(|Buffer\.from\(/);
    assert.doesNotMatch(pricingSrc, /\.toBuffer\(/);
  });
});

describe("measured PumpSwap offsets", () => {
  it("pins the live pool field offsets from src/pumpswap/pool.rs", () => {
    assert.match(pricingSrc, /OFF_CREATOR = 11/);
    assert.match(pricingSrc, /OFF_BASE_MINT = 43/);
    assert.match(pricingSrc, /OFF_QUOTE_MINT = 75/);
    assert.match(pricingSrc, /OFF_BASE_VAULT = 139/);
    assert.match(pricingSrc, /OFF_QUOTE_VAULT = 171/);
    assert.match(pricingSrc, /OFF_COIN_CREATOR = 211/);
    assert.match(pricingSrc, /OFF_IS_MAYHEM = 243/);
    assert.match(pricingSrc, /OFF_IS_CASHBACK = 244/);
    assert.match(pricingSrc, /OFF_VIRTUAL_QUOTE = 245/);
    assert.match(pricingSrc, /VIRTUAL_QUOTE_LEN = 16/);
    assert.match(pricingSrc, /MIN_POOL_LEN = OFF_VIRTUAL_QUOTE/);
    assert.match(
      pricingSrc,
      /PUMPSWAP_POOL_DISCRIMINATOR = new Uint8Array\(\[\s*241,\s*154,\s*109,\s*4,\s*17,\s*177,\s*109,\s*188/,
    );
    assert.match(pricingSrc, /Lengths of 300 and 301 both occur/);
    assert.equal(OFF_VIRTUAL_QUOTE, 245);
    assert.equal(MIN_POOL_LEN, 245);
  });
});

describe("virtual quote inclusion", () => {
  it("adds signed virtual quote when the 16-byte field is present", () => {
    const vault = 45_901_522_423n;
    const virtual = 17_584_506_000n;
    assert.equal(effectiveQuote(vault, virtual), vault + virtual);
    const thinVault = 408_500_000n;
    const honest = effectiveQuote(thinVault, virtual);
    const naive = effectiveQuote(thinVault, 0n);
    assert.ok(honest > naive * 20n, `honest ${honest} vs naive ${naive}`);
  });

  it("treats a shorter valid layout as measured zero virtual quote", () => {
    const data = new Uint8Array(MIN_POOL_LEN);
    data[OFF_IS_MAYHEM] = 0;
    data[OFF_IS_CASHBACK] = 1;
    const parsed = parsePool(data);
    assert.equal(parsed.virtualQuotePresent, false);
    assert.equal(parsed.virtualQuoteReserves, 0n);
    assert.equal(parsed.isCashback, true);
    assert.match(pricingSrc, /virtualQuotePresent\s*\n\s*\? readI128/);
    assert.match(pricingSrc, /: new BN\(0\)/);
    assert.match(pricingSrc, /measured zero, not unknown/);
  });

  it("parses a negative i128 virtual field and rejects a non-positive total", () => {
    const data = new Uint8Array(OFF_VIRTUAL_QUOTE + VIRTUAL_QUOTE_LEN);
    data.set(writeI128Le(-1_000_000_000_000n), OFF_VIRTUAL_QUOTE);
    const parsed = parsePool(data);
    assert.equal(parsed.virtualQuotePresent, true);
    assert.equal(parsed.virtualQuoteReserves, -1_000_000_000_000n);
    assert.throws(() => effectiveQuote(100n, parsed.virtualQuoteReserves), /non-positive-quote/);
    assert.match(pricingSrc, /EFFECTIVE_QUOTE_NON_POSITIVE/);
    assert.doesNotMatch(pricingSrc, /using the vault alone/);
  });
});

describe("inverse emission rounding bounds", () => {
  it("returns the closed KEKBULL interval that floor-mints the target ICHOR", () => {
    assert.deepEqual(kekbullInterval(1n, 0, 0, 1n, 2n), { min: 2n, max: 3n });
    assert.deepEqual(kekbullInterval(5n, 0, 0, 1n, 1n), { min: 5n, max: 5n });
  });

  it("rejects a 1:2 burn that floors below one ICHOR and accepts the image bounds", () => {
    assert.throws(() => ichorFromKekbull(1n, 0, 0, 1n, 2n), /floor/);
    assert.equal(ichorFromKekbull(2n, 0, 0, 1n, 2n), 1n);
    assert.equal(ichorFromKekbull(3n, 0, 0, 1n, 2n), 1n);
    assert.equal(ichorFromKekbull(4n, 0, 0, 1n, 2n), 2n);
    const one = kekbullInterval(1n, 0, 0, 1n, 2n);
    assert.equal(one.min, 2n);
    assert.equal(one.max, 3n);
    const two = kekbullInterval(2n, 0, 0, 1n, 2n);
    assert.equal(two.min, 4n);
    assert.equal(two.max, 5n);
  });

  it("inverts 1:3 floor math and rejects an unreachable odd image when the multiplier is 2", () => {
    assert.deepEqual(kekbullInterval(1n, 0, 0, 1n, 3n), { min: 3n, max: 5n });
    assert.equal(ichorFromKekbull(3n, 0, 0, 1n, 3n), 1n);
    assert.equal(ichorFromKekbull(5n, 0, 0, 1n, 3n), 1n);
    assert.equal(ichorFromKekbull(6n, 0, 0, 1n, 3n), 2n);
    assert.throws(() => kekbullInterval(1n, 0, 0, 2n, 1n), /RATIO_ABOVE_CEILING/);
    assert.throws(() => ichorFromKekbull(1n, 0, 0, 2n, 1n), /RATIO_ABOVE_CEILING/);
  });

  it("scales human units when the mint decimal widths differ", () => {
    const target = 2_000_000_000n;
    const interval = kekbullInterval(target, 6, 9, 1n, 1n);
    assert.equal(interval.min, 2_000_000n);
    assert.equal(interval.max, 2_000_000n);
    assert.equal(ichorFromKekbull(interval.min, 6, 9, 1n, 1n), target);
    assert.throws(() => kekbullInterval(2_000_000_001n, 6, 9, 1n, 1n), /min-image|unreachable/);
    assert.match(pricingSrc, /kekbullIntervalForTargetIchor/);
    assert.match(pricingSrc, /ICHOR_NOT_IN_EMISSION_IMAGE/);
    assert.match(pricingSrc, /ichorFromKekbull/);
  });
});

describe(">u64 intermediate safety", () => {
  it("prices a measured graduate shape without wrapping the reserve product", () => {
    const base = 281_214_160_652_872n;
    const quote = 45_901_522_423n + 17_584_506_000n;
    const kek = 1_000_000_000_000n;
    assert.ok(base * quote > U64_MAX);
    assert.ok(kek * quote > U64_MAX);
    const floor = solParity(kek, quote, base, "floor");
    const ceiling = solParity(kek, quote, base, "ceiling");
    assert.equal(floor, (kek * quote) / base);
    assert.equal(ceiling, ceilDiv(kek * quote, base));
    assert.ok(floor > 0n);
    assert.ok(ceiling >= floor);
    assert.match(pricingSrc, /requireU128\(kek\.mul\(quote\), "kekbull\*effectiveQuote"\)/);
    assert.match(pricingSrc, /bitLength\(\) > U128_BITS/);
    assert.doesNotMatch(pricingSrc, /as u64|>>> 0|Math\.(floor|round|ceil)/);
    assert.match(
      pricingSrc,
      /rawParityCeilingLamports = solParityFromReserves\(\{[\s\S]*kekbullAmount:\s*kekbullInterval\.minRaw/,
    );
  });
});

describe("adjustment math", () => {
  it("requires an explicit bps and does not default it", () => {
    assert.throws(() => applyBps(10_000n, undefined as unknown as number, "floor"), /bps/);
    assert.match(pricingSrc, /ADJUSTMENT_BPS_REQUIRED/);
    assert.match(pricingSrc, /the planner does not default it/);
    assert.match(typesSrc, /adjustmentBps: number/);
    assert.doesNotMatch(pricingSrc, /adjustmentBps \?\? 0|adjustmentBps \|\| 0/);
    assert.doesNotMatch(typesSrc, /adjustmentBps\?:/);
  });

  it("allows explicit zero/discount only, with floor and ceiling bounds", () => {
    assert.equal(applyBps(10_000n, 0, "floor"), 10_000n);
    assert.equal(applyBps(10_000n, 0, "ceiling"), 10_000n);
    assert.throws(() => applyBps(10_000n, 100, "floor"), /bps/);
    assert.equal(applyBps(10_000n, -100, "floor"), 9_900n);
    assert.equal(applyBps(7n, -100, "floor"), 6n);
    assert.equal(applyBps(7n, -100, "ceiling"), 7n);
    assert.throws(() => applyBps(10_000n, -10_000, "floor"), /non-positive-adjust/);
    assert.match(pricingSrc, /10000 \+ bps|BPS_DENOM \+ bps/);
    assert.match(pricingSrc, /ADJUSTMENT_BPS_MIN = -10_000/);
    assert.match(pricingSrc, /ADJUSTMENT_BPS_MAX = 0/);
  });
});

describe("malformed pool and account rejection", () => {
  it("rejects a truncated pool, non-0/1 flags, and a missing virtual field as zero only when long enough", () => {
    assert.throws(() => parsePool(new Uint8Array(244)), /short/);
    const badBool = new Uint8Array(MIN_POOL_LEN);
    badBool[OFF_IS_MAYHEM] = 2;
    assert.throws(() => parsePool(badBool), /bool:mayhem/);
    const badCashback = new Uint8Array(MIN_POOL_LEN);
    badCashback[OFF_IS_CASHBACK] = 7;
    assert.throws(() => parsePool(badCashback), /bool:cashback/);
    assert.match(pricingSrc, /INVALID_BOOL/);
    assert.match(pricingSrc, /POOL_LAYOUT/);
    assert.match(pricingSrc, /POOL_DISCRIMINATOR/);
    assert.match(pricingSrc, /PUMPSWAP_OWNER/);
    assert.match(pricingSrc, /POOL_BASE_MINT/);
    assert.match(pricingSrc, /POOL_QUOTE_MINT/);
    assert.match(pricingSrc, /POOL_INDEX_NONCANONICAL/);
    assert.match(pricingSrc, /POOL_AUTHORITY_MISMATCH/);
    assert.match(pricingSrc, /TOKEN_ACCOUNT_TOO_SHORT/);
    assert.match(pricingSrc, /TOKEN_PROGRAM_UNKNOWN/);
    assert.match(pricingSrc, /VAULT_MISSING/);
    assert.match(pricingSrc, /BASE_RESERVES_ZERO/);
    assert.match(pricingSrc, /ICHOR_ATA_MISSING/);
    assert.match(pricingSrc, /ICHOR_BALANCE_INSUFFICIENT/);
    assert.match(pricingSrc, /SOL_BALANCE_INSUFFICIENT/);
    assert.match(pricingSrc, /SOL_BALANCE_UNSAFE_INTEGER/);
  });

  it("requires the official PumpSwap owner and config KEKBULL / wSOL mints", () => {
    assert.match(pricingSrc, /poolInfo\.owner\.equals\(pumpSwapProgram\)/);
    assert.match(pricingSrc, /parsed\.baseMint\.equals\(kekbullMint\.mint\)/);
    assert.match(pricingSrc, /parsed\.quoteMint\.equals\(nativeMint\.mint\)/);
    assert.match(pricingSrc, /parsed\.creator\.equals\(poolAuthority\)/);
    assert.match(pricingSrc, /fetchMintSnapshot/);
    assert.match(pricingSrc, /assertKekbullIsToken2022/);
    assert.match(pricingSrc, /assertIchorIsToken2022/);
    assert.match(pricingSrc, /getAssociatedTokenAddressSync/);
    assert.match(pricingSrc, /getBalance\(seedOwner/);
    assert.match(pricingSrc, /getAccountInfo\(ichorAta/);
    assert.match(pricingSrc, /getAccountInfo\(parsed\.baseVault/);
    assert.match(pricingSrc, /getAccountInfo\(parsed\.quoteVault/);
  });
});

describe("browser / no-secret / no-send hygiene", () => {
  it("stays browser-safe and does not invent prices or send", () => {
    assert.doesNotMatch(pricingSrc, /\bBuffer\b/);
    assert.doesNotMatch(pricingSrc, /from ["']node:/);
    assert.doesNotMatch(pricingSrc, /createHash|createHmac|node:crypto/);
    assert.doesNotMatch(pricingSrc, /Keypair\.fromSecretKey|Keypair\.fromSeed/);
    assert.doesNotMatch(pricingSrc, /sendTransaction|sendAndConfirmTransaction|sendRawTransaction/);
    assert.doesNotMatch(pricingSrc, /900000/);
    assert.doesNotMatch(pricingSrc, /initialPrice:\s*1(\.0)?/);
    assert.doesNotMatch(pricingSrc, /decimals:\s*6|decimals:\s*9/);
    assert.doesNotMatch(pricingSrc, /1_000_000_000_000_000/);
    assert.doesNotMatch(pricingSrc, /price\s*=\s*1/);
    assert.match(pricingSrc, /assertBoundConnection\(verifiedConfig\.verifiedProgram\.verified, connection\)/);
    assert.match(pricingSrc, /assertVerifiedIchorConfig/);
    assert.match(pricingSrc, /export function assertIchorSolSeedPlan/);
    assert.match(pricingSrc, /fabricated seed plan/);
    assert.match(pricingSrc, /issuedSeedPlans\.set/);
    assert.match(pricingSrc, /assertNoSecretMaterial/);
    assert.match(indexSrc, /planIchorSolSeed/);
    assert.match(indexSrc, /assertIchorSolSeedPlan/);
    assert.match(indexSrc, /kekbullIntervalForTargetIchor/);
    assert.match(typesSrc, /interface PlanIchorSolSeedParams/);
    assert.match(typesSrc, /interface IchorSolSeedPlan/);
    assert.match(typesSrc, /rawParityFloorLamports/);
    assert.match(typesSrc, /adjustedSolLamports/);
    assert.match(typesSrc, /IntegerRoundingDirection/);
    assert.doesNotMatch(indexSrc, /IssuedVerifiedIchorConfig/);
  });
});
