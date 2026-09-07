/**
 * V-6-7: production dist and deploy-dao ship trees may not carry named
 * cluster JSON. Guarded deployment.json stays authoritative.
 * Official-devnet still overlays public/deployment.devnet.json.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertShippedDeploymentJson } from "../scripts/deployment-guard.ts";
import { operatorOnly, websiteRoot } from "./operator-tree.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const website = websiteRoot ?? join(root, "..", "..", "website");

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(path, acc);
    } else {
      acc.push(path);
    }
  }
  return acc;
}

function namedDeploymentJson(dir: string): string[] {
  return walkFiles(dir)
    .map((path) => basename(path))
    .filter((name) => name !== "deployment.json" && /^deployment.*\.json$/i.test(name))
    .sort();
}

function writeFakeSpa(dir: string, extras: boolean): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><title>ICHOR Governance</title><h1>ICHOR Governance</h1>\n",
  );
  copyFileSync(join(root, "public/deployment.json"), join(dir, "deployment.json"));
  if (extras) {
    copyFileSync(join(root, "public/deployment.devnet.json"), join(dir, "deployment.devnet.json"));
    copyFileSync(join(root, "public/deployment.mainnet.json"), join(dir, "deployment.mainnet.json"));
  }
}

function runDeployDao(args: {
  dist: string;
  dest: string;
  devnet?: boolean;
  env?: NodeJS.ProcessEnv;
}): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [join(website, "deploy-dao.sh"), ...(args.devnet ? ["--devnet"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      DAO_DIST: args.dist,
      DAO_DEST: args.dest,
      DAO_GUARD_ONLY: "1",
      ...args.env,
    },
  });
}

function writeSkipNamedRm(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "rm"),
    `#!/usr/bin/env bash
set -euo pipefail
real=/bin/rm
args=()
skip=0
for arg in "$@"; do
  base="\${arg##*/}"
  if [[ "\$base" == "deployment.devnet.json" || "\$base" == "deployment.mainnet.json" ]]; then
    skip=1
    continue
  fi
  args+=("\$arg")
done
if [[ \$skip -eq 1 && \${#args[@]} -eq 1 && "\${args[0]}" == "-f" ]]; then
  exit 0
fi
exec "\$real" "\${args[@]}"
`,
    { mode: 0o755 },
  );
}

describe("mainnet dist deployment hygiene", () => {
  it("npm run build ships only guarded deployment.json", () => {
    const viteBin = join(root, "node_modules/.bin/vite");
    assert.equal(existsSync(viteBin), true, "vite must already be installed; do not npm install from this test");
    assert.equal(existsSync(join(root, "public/deployment.devnet.json")), true);
    assert.equal(existsSync(join(root, "public/deployment.mainnet.json")), true);
    const outDir = mkdtempSync(join(tmpdir(), "ichor-gov-dist-"));
    try {
      const result = spawnSync("npm", ["run", "build", "--", "--outDir", outDir], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `npm run build failed:\n${result.stdout}\n${result.stderr}`);
      const guarded = join(outDir, "deployment.json");
      assert.equal(existsSync(guarded), true);
      assert.equal(assertShippedDeploymentJson(JSON.parse(readFileSync(guarded, "utf8"))), "pre-d");
      assert.deepEqual(namedDeploymentJson(outDir), []);
      assert.equal(existsSync(join(outDir, "deployment.devnet.json")), false);
      assert.equal(existsSync(join(outDir, "deployment.mainnet.json")), false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("deploy-dao named deployment JSON", () => {
  it("mainnet guard-only cannot ship leftover named JSON", operatorOnly, () => {
    const work = mkdtempSync(join(tmpdir(), "ichor-dao-mainnet-"));
    try {
      const dist = join(work, "dist");
      writeFakeSpa(dist, true);
      const result = runDeployDao({ dist, dest: join(work, "kekbull-dao") });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /guard-ok cluster=mainnet-beta/);
      assert.doesNotMatch(result.stdout + result.stderr, /deployment\.devnet\.json|deployment\.mainnet\.json/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("devnet overlay still lands from public/ when dist has no named JSON", operatorOnly, () => {
    const work = mkdtempSync(join(tmpdir(), "ichor-dao-devnet-"));
    try {
      const dist = join(work, "dist");
      writeFakeSpa(dist, false);
      assert.equal(existsSync(join(dist, "deployment.devnet.json")), false);
      const result = runDeployDao({
        dist,
        dest: join(work, "kekbull-dao-devnet"),
        devnet: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /guard-ok cluster=devnet/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("refuses a mainnet ship tree that still contains named JSON", operatorOnly, () => {
    const work = mkdtempSync(join(tmpdir(), "ichor-dao-refuse-"));
    try {
      const dist = join(work, "dist");
      writeFakeSpa(dist, true);
      const bin = join(work, "bin");
      writeSkipNamedRm(bin);
      const result = runDeployDao({
        dist,
        dest: join(work, "kekbull-dao"),
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /still contains deployment\.(devnet|mainnet)\.json/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("refuses a devnet ship tree that still contains named JSON", operatorOnly, () => {
    const work = mkdtempSync(join(tmpdir(), "ichor-dao-refuse-dn-"));
    try {
      const dist = join(work, "dist");
      writeFakeSpa(dist, true);
      const bin = join(work, "bin");
      writeSkipNamedRm(bin);
      const result = runDeployDao({
        dist,
        dest: join(work, "kekbull-dao-devnet"),
        devnet: true,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /still contains deployment\.(devnet|mainnet)\.json/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
