/**
 * Locating the operator-side deployment tree, when there is one.
 *
 * Several assertions here are about how this project is DEPLOYED, not about
 * what it does: that the systemd units bind loopback, that a unit restarts on
 * failure, that a runbook documents a procedure without embedding a
 * credential. Those live outside this package -- in `website/` and in
 * `scripts/*-RUNBOOK.md` -- and they are deliberately not published.
 *
 * The public repository is `ichor/` minus the operator harness, so a fresh
 * clone has none of those files. A test that hard-fails on their absence
 * would mean the suite is red the moment anybody clones the repo, and an
 * outside contributor cannot then tell their own breakage from ours. That is
 * how a project stops receiving pull requests.
 *
 * So these tests skip when the operator tree is absent and run unchanged when
 * it is present. The distinction is deliberate and worth stating plainly: the
 * checks are NOT weakened. In the operator's own checkout -- the only place
 * the deployment can actually be got wrong -- every one of them still runs and
 * still fails loudly.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The `website/` directory of the private checkout, or null when published. */
export const websiteRoot: string | null = (() => {
  const candidate = join(uiRoot, "..", "..", "website");
  return existsSync(join(candidate, "Caddyfile")) ? candidate : null;
})();

export const hasOperatorTree = websiteRoot !== null;

/**
 * Skip reason for `it(name, operatorOnly, fn)`, or an empty object when the
 * operator tree is present. Node's runner takes `{ skip: string }`.
 */
export const operatorOnly: { skip?: string } = hasOperatorTree
  ? {}
  : { skip: "operator deployment tree not present (published repo)" };

/** Read a file from `website/`. Only call inside an `operatorOnly` test. */
export function readWebsite(name: string): string {
  if (websiteRoot === null) {
    throw new Error("readWebsite called without an operator tree");
  }
  return readFileSync(join(websiteRoot, name), "utf8");
}

/** True when an unpublished helper doc (a RUNBOOK) is present. */
export function hasScript(relPath: string): boolean {
  return existsSync(join(uiRoot, relPath));
}

/** Skip reason for a test that reads an unpublished file under this package. */
export function requiresScript(relPath: string): { skip?: string } {
  return hasScript(relPath) ? {} : { skip: `${relPath} not present (published repo)` };
}

export function readScript(relPath: string): string {
  return readFileSync(join(uiRoot, relPath), "utf8");
}
