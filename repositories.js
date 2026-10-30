"use strict";

/**
 * Git Lens — bounded multi-repository discovery.
 *
 * A workspace is not always one repository: a project folder can simply hold
 * several independent checkouts side by side (`frontend`, `backend`,
 * `shared`, …). This module finds them without ever running git against a
 * directory the user did not open:
 *
 * - The walk starts at the workspace and is bounded by depth (3) and by a
 *   visited-directory cap, so a deep tree can never stall the panel.
 * - Generated trees (`node_modules`, `build`, `dist`, `target`, `vendor`, …)
 *   and dot directories (`.git`, `.cache`, `.next`, …) are skipped.
 * - Symlinks/junctions are never followed, so a link cannot smuggle in a
 *   repository from outside the workspace.
 * - A `.git` directory *or* a `.git` file (worktree/submodule checkout) marks a
 *   repository; the marker is verified with `git rev-parse --show-toplevel`
 *   (injected here as `resolveRepoRoot`) and results are deduplicated by
 *   canonical path.
 * - The workspace's own repository — including an ancestor root when the
 *   workspace is a subdirectory of a repo — is always reported first, so
 *   single-repository behaviour is unchanged.
 * - Candidates that fail verification are reported as an `inspectionWarning`
 *   (count + first message) instead of disappearing, so the panel can say
 *   "these repositories are usable, but something could not be inspected".
 *
 * Scans are cached per workspace and coalesced, including scans that failed:
 * `refresh` is the only way to rescan, so the renderer's one-second poll can
 * never spawn a filesystem walk or a git run — not even while git is broken.
 */


const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_DIRS = 500;

/** Generated / vendored trees that never contain a repository worth listing. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "vendors",
  "third_party",
  "third-party",
  "dist",
  "build",
  "out",
  "target",
  "obj",
  "coverage",
  "elm-stuff",
  "miniprogram_npm",
  "unpackage",
]);

function isSkippedDirName(name) {
  if (!name || name === "." || name === "..") return true;
  // Dot directories: .git, .cache, .next, .nuxt, .venv, .gradle, .idea, …
  if (name.startsWith(".")) return true;
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

/** Canonical absolute path, or null when the value is not a usable path. */
function canonicalPath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return path.resolve(value);
  } catch {
    return null;
  }
}

/** Case-insensitive comparison key on Windows, exact elsewhere. */
function canonicalKey(value) {
  const canonical = canonicalPath(value);
  if (!canonical) return null;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * Find the discovered repository a request names. Only exact roots are
 * accepted: subdirectories, sibling checkouts that discovery skipped and
 * arbitrary paths all return null.
 */
function findRepository(repos, candidate) {
  const key = canonicalKey(candidate);
  if (!key || !Array.isArray(repos)) return null;
  for (const repo of repos) {
    if (repo && typeof repo.root === "string" && canonicalKey(repo.root) === key) return repo;
  }
  return null;
}

async function isLinkedPath(target, lstat) {
  try {
    const stat = await lstat(target);
    return Boolean(stat && typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink());
  } catch {
    return false;
  }
}

async function hasGitMarker(dir, lstat) {
  try {
    const stat = await lstat(path.join(dir, ".git"));
    if (!stat) return false;
    return (
      stat.isDirectory() === true ||
      stat.isFile() === true ||
      (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())
    );
  } catch {
    return false;
  }
}

function errorMessage(error) {
  if (!error) return "unknown error";
  return String(error.message || error);
}

function compareRepos(a, b) {
  const left = a.relativePath.toLowerCase();
  const right = b.relativePath.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  if (a.relativePath < b.relativePath) return -1;
  if (a.relativePath > b.relativePath) return 1;
  return 0;
}

/**
 * Discover the repositories of one workspace.
 *
 * Accepts injected `readdir` / `lstat` / `resolveRepoRoot` so tests can run
 * against deterministic trees; production callers only pass `resolveRepoRoot`.
 */
async function discoverRepositories(workspacePath, options = {}) {
  const readdir = options.readdir || ((dir, opts) => fs.readdir(dir, opts));
  const lstat = options.lstat || ((target) => fs.lstat(target));
  const resolveRepoRoot = options.resolveRepoRoot;
  if (typeof resolveRepoRoot !== "function") {
    throw new TypeError("discoverRepositories requires a resolveRepoRoot function");
  }
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0
    ? options.maxDepth
    : DEFAULT_MAX_DEPTH;
  const maxDirs = Number.isInteger(options.maxDirs) && options.maxDirs > 0
    ? options.maxDirs
    : DEFAULT_MAX_DIRS;

  const workspace = canonicalPath(workspacePath);
  if (!workspace) throw new TypeError("discoverRepositories requires a workspace path");

  const result = {
    workspace,
    repos: [],
    error: null,
    inspectionWarning: null,
    truncated: false,
    visited: 0,
    scannedAt: Date.now(),
  };

  // 1. The repository that contains the workspace itself (workspace root or an
  //    ancestor of it). A failure here is remembered but does not abort the
  //    descendant walk — a broken `git` still surfaces through `error`.
  let workspaceRoot = null;
  let workspaceError = null;
  try {
    workspaceRoot = await resolveRepoRoot(workspace);
  } catch (error) {
    workspaceError = error;
  }

  // 2. Bounded breadth-first walk of the descendants.
  const candidates = [];
  const inspectErrors = [];
  const queue = [{ dir: workspace, depth: 0 }];
  let visited = 0;
  let truncated = false;

  while (queue.length) {
    if (visited >= maxDirs) {
      truncated = true;
      break;
    }
    const node = queue.shift();
    if (node.depth >= maxDepth) continue;
    let entries;
    try {
      entries = await readdir(node.dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, race with a delete): skip it.
      continue;
    }
    visited += 1;
    entries = Array.from(entries || []);
    entries.sort((a, b) => {
      const left = String((a && a.name) || "");
      const right = String((b && b.name) || "");
      return left < right ? -1 : left > right ? 1 : 0;
    });

    for (const entry of entries) {
      const name = String((entry && entry.name) || "");
      if (isSkippedDirName(name)) continue;
      let linked = typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink();
      if (!linked) {
        const isDirectory = typeof entry.isDirectory === "function" && entry.isDirectory();
        if (!isDirectory) continue;
        const child = path.join(node.dir, name);
        if (await isLinkedPath(child, lstat)) continue;
        const childDepth = node.depth + 1;
        if (await hasGitMarker(child, lstat)) {
          candidates.push(child);
          continue; // never descend into a repository
        }
        if (childDepth < maxDepth) queue.push({ dir: child, depth: childDepth });
      }
    }
  }

  // 3. Verify candidates with git and deduplicate by canonical path.
  const seen = new Set();
  const repos = [];

  if (workspaceRoot) {
    const canonical = canonicalPath(workspaceRoot);
    const key = canonicalKey(canonical);
    if (canonical && key) {
      seen.add(key);
      repos.push({
        root: canonical,
        name: path.basename(canonical) || canonical,
        relativePath: ".",
        primary: true,
      });
    }
  }

  const descendants = [];
  for (const candidate of candidates) {
    let root = null;
    try {
      root = await resolveRepoRoot(candidate);
    } catch (error) {
      inspectErrors.push(error);
      continue;
    }
    if (!root) continue;
    const canonical = canonicalPath(root);
    const key = canonicalKey(canonical);
    if (!canonical || !key || seen.has(key)) continue;
    seen.add(key);
    const relative = path.relative(workspace, canonical) || ".";
    descendants.push({
      root: canonical,
      name: path.basename(canonical) || canonical,
      relativePath: relative.split(path.sep).join("/"),
      primary: false,
    });
  }
  descendants.sort(compareRepos);
  repos.push(...descendants);
  result.repos = repos;
  result.visited = visited;
  result.truncated = truncated;

  // Any inspection failure that did not prevent discovery. With no usable
  // repository it is a hard error; with usable repositories it is a warning so
  // the panel can show the working checkouts and say what could not be read.
  const issues = [];
  if (workspaceError) issues.push(workspaceError);
  for (const issue of inspectErrors) issues.push(issue);
  if (issues.length) {
    if (repos.length) {
      result.inspectionWarning = {
        count: issues.length,
        message: errorMessage(issues[0]),
      };
    } else {
      result.error = `Failed to inspect git repositories: ${errorMessage(issues[0])}`;
    }
  }
  return result;
}

/**
 * Per-workspace discovery cache with coalesced scans.
 *
 * `get(workspace, { refresh: true })` is the only way to rescan; every other
 * call is served from memory — including a scan that failed, so a broken or
 * slow host is not re-probed on every panel poll. `refresh` retries and, once
 * it succeeds, replaces the cached failure.
 */
function createDiscovery(options = {}) {
  const cache = new Map();
  const inFlight = new Map();

  async function get(workspacePath, { refresh = false } = {}) {
    const key = canonicalKey(workspacePath);
    if (!key) throw new TypeError("getRepositoryScan requires a workspace path");

    if (!refresh) {
      const cached = cache.get(key);
      if (cached) return { ...cached, cached: true };
      const pending = inFlight.get(key);
      if (pending) return pending;
    } else {
      const pending = inFlight.get(key);
      if (pending) {
        try {
          await pending;
        } catch {
          /* superseded by the explicit refresh below */
        }
      }
    }

    const promise = discoverRepositories(workspacePath, options)
      .then((scan) => {
        cache.set(key, scan);
        return { ...scan, cached: false };
      })
      .finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  }

  return {
    get,
    invalidate(workspacePath) {
      const key = canonicalKey(workspacePath);
      if (key) cache.delete(key);
    },
    clear() {
      cache.clear();
      inFlight.clear();
    },
    get cachedWorkspaces() {
      return cache.size;
    },
  };
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_DIRS,
  SKIP_DIR_NAMES,
  canonicalPath,
  canonicalKey,
  findRepository,
  discoverRepositories,
  createDiscovery,
};
