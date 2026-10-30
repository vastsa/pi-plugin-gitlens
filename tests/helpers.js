"use strict";

/* Shared fixtures for the Git Lens multi-repository tests.
 *
 * Every fixture lives under GITLENS_TEST_TMPDIR (or the OS temp
 * directory)/gitlens-tests. No test touches a real project: `git` only ever
 * runs with a cwd or -C pointing at a directory created here.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRATCH_ROOT = process.env.GITLENS_TEST_TMPDIR || os.tmpdir();
const TEST_ROOT = path.join(SCRATCH_ROOT, "gitlens-tests");

fs.mkdirSync(TEST_ROOT, { recursive: true });

/** Create a unique fixture workspace directory. */
function makeRoot(label = "ws") {
  return fs.mkdtempSync(path.join(TEST_ROOT, `${label}-`));
}

/** mkdir -p under a fixture root. */
function makeDir(parent, ...segments) {
  const dir = path.join(parent, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run git inside a fixture directory (never a real project). */
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Initialise an independent repository at dir (optionally with one commit). */
function initRepo(dir, options = {}) {
  const { commit = false, message } = options;
  fs.mkdirSync(dir, { recursive: true });
  git(["init"], dir);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
  if (commit) {
    commitFile(dir, "README.md", `# ${path.basename(dir)}\n`, message || `init ${path.basename(dir)}`);
  }
  return dir;
}

/** Write a file, stage everything and commit it inside a fixture repo. */
function commitFile(repo, relativePath, content, message) {
  const file = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  git(["add", "-A"], repo);
  git([
    "-c",
    "user.name=Git Lens Tests",
    "-c",
    "user.email=gitlens-tests@example.invalid",
    "commit",
    "-m",
    message || `update ${relativePath}`,
  ], repo);
}

/** Absolute, resolved fixture path. */
function resolve(...segments) {
  return path.resolve(path.join(...segments));
}

module.exports = {
  SCRATCH_ROOT,
  TEST_ROOT,
  makeRoot,
  makeDir,
  git,
  initRepo,
  commitFile,
  resolve,
};
