#!/usr/bin/env node
// Static guard for CI/release workflow invariants that protect the committed action bundle.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function assertContains(text, needle, message) {
  if (!text.includes(needle)) {
    throw new Error(`${message}: expected to find ${JSON.stringify(needle)}`);
  }
}

function assertNotContains(text, needle, message) {
  if (text.includes(needle)) {
    throw new Error(`${message}: found forbidden ${JSON.stringify(needle)}`);
  }
}

function assertOrdered(text, earlier, later, message) {
  const earlierIndex = text.indexOf(earlier);
  const laterIndex = text.indexOf(later);
  if (earlierIndex === -1 || laterIndex === -1 || earlierIndex >= laterIndex) {
    throw new Error(`${message}: expected ${JSON.stringify(earlier)} before ${JSON.stringify(later)}`);
  }
}

function main() {
  const testWorkflow = read('.github/workflows/test.yml');
  const manualWorkflow = read('.github/workflows/manual-build.yml');
  const releaseWorkflow = read('.github/workflows/release.yml');
  const dependabot = read('.github/dependabot.yml');
  const readme = read('README.md');

  assertContains(testWorkflow, 'push:', 'test workflow must run on main pushes');
  assertContains(testWorkflow, '- main', 'test workflow must target main');
  assertContains(testWorkflow, 'contents: read', 'test workflow permissions must be least-privilege');
  assertNotContains(testWorkflow, 'pull-requests: write', 'test workflow must not request PR write permission');
  assertContains(testWorkflow, 'bun-version: 1.3.14', 'test workflow must pin Bun');
  assertNotContains(testWorkflow, 'matrix.bun', 'test workflow cache key must not reference an undefined matrix');
  assertContains(testWorkflow, 'bun install --frozen-lockfile', 'test workflow must enforce the lockfile');
  assertOrdered(testWorkflow, 'bun run check:contract', 'bun run build', 'contract drift check must run before build');
  assertOrdered(testWorkflow, 'bun run typecheck', 'bun run build', 'typecheck must run before build');
  assertContains(testWorkflow, 'bun run build', 'test workflow must build the ncc bundle');
  assertContains(testWorkflow, 'git diff --exit-code -- lib/index.js', 'test workflow must fail on stale lib bundle');
  assertContains(testWorkflow, 'actions/upload-artifact@v4', 'test workflow must preserve test artifacts');
  assertContains(testWorkflow, "env.CODECOV_TOKEN != ''", 'Codecov uploads must be token-gated');

  assertContains(manualWorkflow, 'permissions:', 'manual version workflow must declare permissions');
  assertContains(manualWorkflow, 'contents: write', 'manual version workflow needs contents write for the PR branch');
  assertContains(manualWorkflow, 'pull-requests: write', 'manual version workflow needs PR write for create-pull-request');
  assertContains(manualWorkflow, 'bun-version: 1.3.14', 'manual version workflow must pin Bun');
  assertNotContains(manualWorkflow, 'matrix.bun', 'manual version workflow cache key must not reference an undefined matrix');
  assertContains(manualWorkflow, 'bun install --frozen-lockfile', 'manual version workflow must enforce the lockfile');
  assertContains(manualWorkflow, 'JSON.parse', 'manual version workflow must parse package.json as JSON');
  assertContains(manualWorkflow, 'bun run check:contract', 'manual version workflow must run contract drift check');
  assertContains(manualWorkflow, 'bun run typecheck', 'manual version workflow must run typecheck');
  assertContains(manualWorkflow, 'bun run test', 'manual version workflow must run tests before creating a PR');
  assertContains(manualWorkflow, 'bun run test:coverage', 'manual version workflow must run coverage before creating a PR');
  assertContains(manualWorkflow, 'git diff --exit-code -- lib/index.js', 'manual version workflow must verify the lib bundle');
  assertContains(manualWorkflow, 'branch: version-bump/${{ env.NEW_VERSION }}', 'manual version workflow branch must be version-scoped');
  assertNotContains(manualWorkflow, 'rickstaa/action-create-tag', 'manual version workflow must not tag before PR merge');
  assertNotContains(manualWorkflow, 'softprops/action-gh-release', 'manual version workflow must not release before PR merge');
  assertNotContains(manualWorkflow, 'force_push_tag: true', 'release tags must not be force-pushed');

  assertContains(releaseWorkflow, 'on:', 'release workflow must exist');
  assertContains(releaseWorkflow, 'push:', 'release workflow must run from pushed main commits');
  assertContains(releaseWorkflow, 'branches:', 'release workflow must constrain branches');
  assertContains(releaseWorkflow, '- main', 'release workflow must target main');
  assertContains(releaseWorkflow, 'contents: write', 'release workflow needs contents write for tag/release');
  assertContains(releaseWorkflow, 'bun-version: 1.3.14', 'release workflow must pin Bun');
  assertContains(releaseWorkflow, 'bun install --frozen-lockfile', 'release workflow must enforce the lockfile');
  assertContains(releaseWorkflow, 'bun run check:contract', 'release workflow must run contract drift check');
  assertContains(releaseWorkflow, 'bun run typecheck', 'release workflow must run typecheck');
  assertContains(releaseWorkflow, 'bun run test', 'release workflow must run tests before tag/release');
  assertContains(releaseWorkflow, 'bun run test:coverage', 'release workflow must run coverage before tag/release');
  assertContains(releaseWorkflow, 'git diff --exit-code -- lib/index.js', 'release workflow must verify the lib bundle');
  assertContains(releaseWorkflow, 'SHOULD_RELEASE=false', 'release workflow must skip release creation when version is unchanged');
  assertContains(releaseWorkflow, 'git rev-parse "v${NEW_VERSION}"', 'release workflow must fail if a version tag already exists');
  assertContains(releaseWorkflow, "if: env.SHOULD_RELEASE == 'true'", 'release workflow tag/release steps must be version-change gated');
  assertNotContains(releaseWorkflow, 'force_push_tag: true', 'release workflow must never force-push tags');

  assertContains(dependabot, "package-ecosystem: 'github-actions'", 'Dependabot must update workflow actions');
  assertContains(readme, 'The committed GitHub Action bundle is `lib/index.js`.', 'README must document the official bundle path');

  console.log('[ci-release-workflows] OK');
}

try {
  main();
} catch (error) {
  console.error(`[ci-release-workflows] FAIL: ${error.message}`);
  process.exit(1);
}
