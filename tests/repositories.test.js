"use strict";

/* Discovery tests. These are written against the discovery contract:
 *
 *   discoverRepositories(workspacePath, { readdir, lstat, resolveRepoRoot,
 *                                          maxDepth, maxDirs })
 *     -> { workspace, repos: [{ root, name, relativePath, primary }],
 *          error, truncated, visited, scannedAt }
 *   createDiscovery(options).get(workspacePath, { refresh }) -> same + cached
 *   findRepository(repos, candidate) -> repo entry | null
 *
 * Real git repositories are only ever created under the temp directory
 * (tests/helpers.js); no existing project is touched.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const helpers = require("./helpers");

let repositoriesModule = null;
let loadError = null;
try {
  repositoriesModule = require("../repositories");
} catch (error) {
  loadError = error;
}

function impl() {
  if (!repositoriesModule) {
    throw new Error(`repositories.js is missing or failed to load: ${loadError && loadError.message}`);
  }
  return repositoriesModule;
}

/** Real fs + real git (against temp fixtures only). */
function realDeps(overrides = {}) {
  const { resolveRepoRoot } = require("../git");
  return {
    readdir: (dir, options) => fs.promises.readdir(dir, options),
    lstat: (target) => fs.promises.lstat(target),
    resolveRepoRoot,
    ...overrides,
  };
}

async function discover(workspace, overrides = {}) {
  const { discoverRepositories } = impl();
  return discoverRepositories(workspace, { ...realDeps(), ...overrides });
}

const names = (result) => result.repos.map((repo) => repo.name);

/* ------------------------------------------------------------------------- */
/* fake fs helpers (deterministic, no real disk)                              */
/* ------------------------------------------------------------------------- */

function dirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "link",
  };
}

/**
 * Build an injectable fs.
 * dirs     : { absoluteDir: [{ name, kind }] }
 * markers  : absolute repo dirs that contain a `.git` entry
 * links    : absolute paths whose lstat reports a symlink
 */
function fakeFs({ dirs = {}, markers = [], links = [] } = {}) {
  const keys = Object.keys(dirs);
  const api = {
    readdir: async (dir) => {
      const key = path.resolve(dir);
      if (!keys.includes(key)) {
        const error = new Error(`ENOENT: no such directory ${dir}`);
        error.code = "ENOENT";
        throw error;
      }
      return dirs[key].map((entry) => dirent(entry.name, entry.kind));
    },
    lstat: async (target) => {
      const key = path.resolve(target);
      const stat = (kind) => ({
        isSymbolicLink: () => kind === "link",
        isDirectory: () => kind === "dir",
        isFile: () => kind === "file",
      });
      if (links.includes(key)) return stat("link");
      if (markers.some((marker) => path.resolve(marker, ".git") === key)) return stat("dir");
      const error = new Error(`ENOENT: no such file ${target}`);
      error.code = "ENOENT";
      throw error;
    },
  };
  return api;
}

function fakeResolve(markers, calls) {
  return async (dir) => {
    calls.push(path.resolve(dir));
    return markers.some((marker) => path.resolve(marker) === path.resolve(dir))
      ? path.resolve(dir)
      : null;
  };
}

/* ------------------------------------------------------------------------- */
/* discovery                                                                  */
/* ------------------------------------------------------------------------- */

test("discovers three sibling repositories deterministically", async () => {
  const workspace = helpers.makeRoot("multi");
  helpers.initRepo(path.join(workspace, "api"));
  helpers.initRepo(path.join(workspace, "web"));
  helpers.initRepo(path.join(workspace, "shared"));
  fs.writeFileSync(path.join(workspace, "alias.json"), "{}");

  const result = await discover(workspace);

  assert.equal(result.error, null);
  assert.equal(result.truncated, false);
  assert.deepEqual(names(result), ["api", "shared", "web"]);
  assert.deepEqual(
    result.repos.map((repo) => path.resolve(repo.root)),
    ["api", "shared", "web"].map((name) => path.resolve(workspace, name)),
  );
  for (const repo of result.repos) {
    assert.equal(repo.relativePath, repo.name);
    assert.equal(repo.primary, false);
  }
});

test("repository order does not depend on creation order", async () => {
  const workspace = helpers.makeRoot("order");
  helpers.initRepo(path.join(workspace, "web"));
  helpers.initRepo(path.join(workspace, "api"));
  helpers.initRepo(path.join(workspace, "shared"));

  const result = await discover(workspace);

  assert.deepEqual(names(result), ["api", "shared", "web"]);
});

test("keeps a single repository opened at its own root", async () => {
  const workspace = helpers.makeRoot("single");
  helpers.initRepo(workspace);

  const result = await discover(workspace);

  assert.equal(result.error, null);
  assert.equal(result.repos.length, 1);
  assert.equal(path.resolve(result.repos[0].root), path.resolve(workspace));
  assert.equal(result.repos[0].relativePath, ".");
  assert.equal(result.repos[0].primary, true);
});

test("keeps ancestor-root support for a workspace nested inside a repository", async () => {
  const root = helpers.makeRoot("ancestor");
  helpers.initRepo(root);
  const workspace = helpers.makeDir(root, "packages", "app");

  const result = await discover(workspace);

  assert.equal(result.error, null);
  assert.equal(result.repos.length, 1);
  assert.equal(path.resolve(result.repos[0].root), path.resolve(root));
  assert.equal(result.repos[0].relativePath, ".");
  assert.equal(result.repos[0].primary, true);
});

test("reports zero repositories without an inspection error", async () => {
  const workspace = helpers.makeRoot("plain");
  helpers.makeDir(workspace, "src", "lib");
  fs.writeFileSync(path.join(workspace, "src", "index.js"), "module.exports = 1;\n");

  const result = await discover(workspace);

  assert.deepEqual(result.repos, []);
  assert.equal(result.error, null);
  assert.equal(result.workspace, path.resolve(workspace));
});

test("honours the depth-3 bound", async () => {
  const workspace = helpers.makeRoot("depth");
  helpers.initRepo(path.join(workspace, "a", "b", "c"));
  helpers.initRepo(path.join(workspace, "x", "y", "z", "w"));

  const result = await discover(workspace);

  assert.deepEqual(names(result), ["c"]);
});

test("skips generated directories", async () => {
  const workspace = helpers.makeRoot("skips");
  helpers.initRepo(path.join(workspace, "app"));
  for (const generated of [
    ["node_modules", "pkg"],
    ["vendor", "lib"],
    ["build", "out"],
    ["dist"],
    ["target", "generated"],
    [".cache", "hidden"],
  ]) {
    helpers.initRepo(path.join(workspace, ...generated));
  }

  const result = await discover(workspace);

  assert.deepEqual(names(result), ["app"]);
});

test("does not follow directory links", async (t) => {
  const workspace = helpers.makeRoot("links");
  const outside = helpers.makeRoot("outside");
  helpers.initRepo(outside);
  const link = path.join(workspace, "linked");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch (error) {
    t.skip(`directory links unavailable on this host: ${error.code || error.message}`);
    return;
  }

  const result = await discover(workspace);

  assert.deepEqual(names(result), []);
  assert.equal(impl().findRepository(result.repos, path.join(link, "src")), null);
  assert.equal(impl().findRepository(result.repos, outside), null);
});

test("skips a directory entry that is really a link", async () => {
  const workspace = path.resolve(helpers.makeRoot("fakelink"));
  const linked = path.join(workspace, "linked");
  const api = fakeFs({
    dirs: {
      [workspace]: [{ name: "linked", kind: "dir" }],
      [linked]: [],
    },
    markers: [linked],
    links: [linked],
  });

  const result = await impl().discoverRepositories(workspace, {
    ...api,
    resolveRepoRoot: async () => null,
  });

  assert.deepEqual(result.repos, []);
});

test("supports a .git file (worktree) as a repository marker", async () => {
  const workspace = helpers.makeRoot("worktree");
  const base = helpers.initRepo(path.join(workspace, "base"), { commit: true });
  const worktree = path.join(workspace, "wt");
  helpers.git(["worktree", "add", worktree], base);
  assert.equal(fs.statSync(path.join(worktree, ".git")).isFile(), true);

  const result = await discover(workspace);

  assert.equal(result.error, null);
  assert.deepEqual(names(result), ["base", "wt"]);
  assert.equal(path.resolve(result.repos[1].root), path.resolve(worktree));
});

test("accepts a .git file marker in an injected fs", async () => {
  const workspace = path.resolve(helpers.makeRoot("fakeworktree"));
  const repo = path.join(workspace, "wt");
  const api = fakeFs({
    dirs: {
      [workspace]: [{ name: "wt", kind: "dir" }],
      [repo]: [{ name: ".git", kind: "file" }],
    },
    markers: [repo],
  });

  const result = await impl().discoverRepositories(workspace, {
    ...api,
    resolveRepoRoot: async (dir) => (path.resolve(dir) === path.resolve(repo) ? path.resolve(repo) : null),
  });

  assert.deepEqual(names(result), ["wt"]);
});

test("deduplicates repositories that resolve to the same canonical root", async () => {
  const workspace = path.resolve(helpers.makeRoot("dedup"));
  const one = path.join(workspace, "one");
  const two = path.join(workspace, "two");
  const api = fakeFs({
    dirs: {
      [workspace]: [{ name: "one", kind: "dir" }, { name: "two", kind: "dir" }],
      [one]: [],
      [two]: [],
    },
    markers: [one, two],
  });

  const result = await impl().discoverRepositories(workspace, {
    ...api,
    resolveRepoRoot: async () => path.resolve(one),
  });

  assert.deepEqual(names(result), ["one"]);
});

test("stops at the directory cap and reports truncation", async () => {
  const workspace = path.resolve(helpers.makeRoot("cap"));
  const children = Array.from({ length: 8 }, (_, index) => ({ name: `d${index}`, kind: "dir" }));
  const dirs = { [workspace]: children };
  const markers = [];
  for (const child of children) {
    const dir = path.join(workspace, child.name);
    dirs[dir] = [];
    if (child.name === "d7") markers.push(dir);
  }
  const api = fakeFs({ dirs, markers });

  const result = await impl().discoverRepositories(workspace, {
    ...api,
    resolveRepoRoot: fakeResolve(markers, []),
    maxDirs: 4,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.visited <= 4, `visited ${result.visited} directories`);
  assert.ok(result.repos.length <= 1, `found ${result.repos.length} repositories`);
});

test("surfaces a genuine inspection error instead of pretending there is no repo", async () => {
  const workspace = path.resolve(helpers.makeRoot("broken"));
  const api = fakeFs({ dirs: { [workspace]: [] } });

  const result = await impl().discoverRepositories(workspace, {
    ...api,
    resolveRepoRoot: async () => {
      throw new Error("fatal: git binary exploded");
    },
  });

  assert.deepEqual(result.repos, []);
  assert.match(String(result.error), /git binary exploded/);
});

test("keeps the workspace when discovery fails", async () => {
  const workspace = path.resolve(helpers.makeRoot("broken2"));
  const api = fakeFs({ dirs: {} });

  const result = await impl().discoverRepositories(workspace, {
    ...api,
    resolveRepoRoot: async () => {
      throw new Error("spawn git ENOENT");
    },
  });

  assert.equal(result.workspace, workspace);
  assert.match(String(result.error), /ENOENT/);
});

test("reports a warning when one candidate cannot be inspected but others work", async () => {
  const workspace = path.resolve(helpers.makeRoot("warn"));
  const good = path.join(workspace, "good");
  const broken = path.join(workspace, "broken");
  const api = fakeFs({
    dirs: {
      [workspace]: [{ name: "broken", kind: "dir" }, { name: "good", kind: "dir" }],
      [broken]: [],
      [good]: [],
    },
    markers: [good, broken],
  });

  const result = await impl().discoverRepositories(workspace, {
    ...api,
    resolveRepoRoot: async (dir) => {
      if (path.resolve(dir) === broken) throw new Error("fatal: Invalid gitfile format");
      return path.resolve(good);
    },
  });

  assert.equal(result.error, null);
  assert.deepEqual(names(result), ["good"]);
  assert.ok(result.inspectionWarning, "a partial failure must be reported");
  assert.equal(result.inspectionWarning.count, 1);
  assert.match(result.inspectionWarning.message, /Invalid gitfile format/);
});

test("reports a warning when the workspace probe fails but a descendant repository works", async () => {
  const workspace = path.resolve(helpers.makeRoot("warnworkspace"));
  const app = path.join(workspace, "app");
  const api = fakeFs({
    dirs: {
      [workspace]: [{ name: "app", kind: "dir" }],
      [app]: [],
    },
    markers: [app],
  });

  const result = await impl().discoverRepositories(workspace, {
    ...api,
    resolveRepoRoot: async (dir) => {
      if (path.resolve(dir) === workspace) throw new Error("fatal: cannot change to workspace");
      return path.resolve(app);
    },
  });

  assert.equal(result.error, null);
  assert.deepEqual(names(result), ["app"]);
  assert.equal(result.inspectionWarning.count, 1);
  assert.match(result.inspectionWarning.message, /cannot change to workspace/);
});

test("uses no warning when every repository is inspected cleanly", async () => {
  const workspace = helpers.makeRoot("warnnone");
  helpers.initRepo(path.join(workspace, "api"));

  const result = await discover(workspace);

  assert.equal(result.inspectionWarning, null);
  assert.equal(result.error, null);
});

/* ------------------------------------------------------------------------- */
/* caching                                                                    */
/* ------------------------------------------------------------------------- */

function countingDiscovery({ dirs, markers, maxDirs }) {
  const { createDiscovery } = impl();
  const scanCounter = { root: 0 };
  const api = fakeFs({ dirs, markers });
  const resolveCalls = [];
  const discovery = createDiscovery({
    readdir: async (dir, options) => {
      if (path.resolve(dir) === Object.keys(dirs)[0]) scanCounter.root += 1;
      return api.readdir(dir, options);
    },
    lstat: api.lstat,
    resolveRepoRoot: fakeResolve(markers, resolveCalls),
    maxDirs,
  });
  return { discovery, scanCounter, resolveCalls };
}

test("caches a scan and only rescans on explicit refresh", async () => {
  const workspace = path.resolve(helpers.makeRoot("cache"));
  const repo = path.join(workspace, "app");
  const { discovery, scanCounter } = countingDiscovery({
    dirs: {
      [workspace]: [{ name: "app", kind: "dir" }],
      [repo]: [],
    },
    markers: [repo],
  });

  const first = await discovery.get(workspace);
  const second = await discovery.get(workspace);
  const third = await discovery.get(workspace, { refresh: true });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(third.cached, false);
  assert.equal(scanCounter.root, 2);
  assert.deepEqual(names(second), ["app"]);
  assert.deepEqual(names(third), ["app"]);
});

test("coalesces concurrent scans for the same workspace", async () => {
  const workspace = path.resolve(helpers.makeRoot("coalesce"));
  const repo = path.join(workspace, "app");
  const { discovery, scanCounter } = countingDiscovery({
    dirs: {
      [workspace]: [{ name: "app", kind: "dir" }],
      [repo]: [],
    },
    markers: [repo],
  });

  const [a, b] = await Promise.all([discovery.get(workspace), discovery.get(workspace)]);

  assert.equal(scanCounter.root, 1);
  assert.deepEqual(names(a), ["app"]);
  assert.deepEqual(names(b), ["app"]);
});

test("caches a failed scan until an explicit refresh recovers", async () => {
  const workspace = path.resolve(helpers.makeRoot("cacheerror"));
  const repo = path.join(workspace, "app");
  const { createDiscovery } = impl();
  const api = fakeFs({
    dirs: {
      [workspace]: [{ name: "app", kind: "dir" }],
      [repo]: [],
    },
    markers: [repo],
  });
  let broken = true;
  let scans = 0;
  const discovery = createDiscovery({
    ...api,
    readdir: async (dir, options) => {
      if (path.resolve(dir) === workspace) scans += 1;
      return api.readdir(dir, options);
    },
    resolveRepoRoot: async (dir) => {
      if (broken) throw new Error("boom");
      return path.resolve(dir) === repo ? repo : null;
    },
  });

  const first = await discovery.get(workspace);
  const second = await discovery.get(workspace);

  // A failing scan is cached too: the one-second poll must not retry it.
  assert.match(String(first.error), /boom/);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.match(String(second.error), /boom/);
  assert.equal(scans, 1);

  // Explicit refresh retries and replaces the cached failure.
  broken = false;
  const refreshed = await discovery.get(workspace, { refresh: true });
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.error, null);
  assert.deepEqual(refreshed.repos.map((entry) => entry.name), ["app"]);

  const afterRecovery = await discovery.get(workspace);
  assert.equal(afterRecovery.cached, true);
  assert.equal(afterRecovery.error, null);
  assert.deepEqual(afterRecovery.repos.map((entry) => entry.name), ["app"]);
});

/* ------------------------------------------------------------------------- */
/* allowed-root validation                                                    */
/* ------------------------------------------------------------------------- */

test("findRepository only allows exact discovered roots", async () => {
  const workspace = helpers.makeRoot("allowed");
  helpers.initRepo(path.join(workspace, "api"));
  helpers.initRepo(path.join(workspace, "node_modules", "evil"));
  const result = await discover(workspace);
  const { findRepository } = impl();
  const ui = path.join(workspace, "api");

  assert.ok(findRepository(result.repos, ui));
  assert.ok(findRepository(result.repos, ui.replace(/\\/g, "/")));
  assert.equal(findRepository(result.repos, path.join(ui, "src")), null);
  assert.equal(findRepository(result.repos, path.join(workspace, "node_modules", "evil")), null);
  assert.equal(findRepository(result.repos, path.join(workspace, "nope")), null);
  assert.equal(findRepository(result.repos, ".."), null);
  assert.equal(findRepository(result.repos, ""), null);
  assert.equal(findRepository(result.repos, null), null);
  assert.equal(findRepository(result.repos, path.resolve(workspace, "..", "elsewhere")), null);
});

test("findRepository matches Windows paths case-insensitively", async (t) => {
  if (process.platform !== "win32") {
    t.skip("case-insensitive comparison is Windows-only");
    return;
  }
  const workspace = helpers.makeRoot("case");
  helpers.initRepo(path.join(workspace, "api"));
  const result = await discover(workspace);
  const upper = path.join(workspace, "api").toUpperCase();

  assert.ok(impl().findRepository(result.repos, upper));
});
