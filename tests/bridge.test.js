"use strict";

/* Bridge (onPanelInvoke) tests for multi-repository workspaces.
 *
 * Every workspace and repository used here is created under the temp
 * directory by tests/helpers.js. No real project is ever opened, read or
 * written by these tests.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const helpers = require("./helpers");

let main = null;
let loadError = null;
try {
  main = require("../main");
} catch (error) {
  loadError = error;
}

function impl() {
  if (!main) {
    throw new Error(`main.js failed to load: ${loadError && loadError.message}`);
  }
  return main;
}

/** Install a minimal host (`pi`) with the given workspace path (or none). */
function installHost(workspacePath) {
  global.pi = {
    workspace: {
      get: async () =>
        workspacePath ? { path: workspacePath, name: path.basename(workspacePath) } : null,
    },
    app: {
      getLocale: async () => "en",
      getAppearance: async () => ({ base: "dark", theme: "dark", locale: "en" }),
    },
    ui: { showToast: async () => {} },
    commands: { register: async () => {}, unregister: async () => {} },
  };
}

function invoke(channel, payload) {
  return impl().onPanelInvoke(channel, payload);
}

const repoNames = (state) => state.repositories.map((repo) => repo.name);

test("git.state reports no workspace without throwing", async () => {
  installHost(null);

  const state = await invoke("git.state", {});

  assert.equal(state.ok, true);
  assert.equal(state.workspace, null);
  assert.deepEqual(state.repositories, []);
  assert.equal(state.repoRoot, null);
  assert.equal(state.inspectionError, null);
});

test("git.state lists every discovered repository and picks the first", async () => {
  const workspace = helpers.makeRoot("bridge-multi");
  helpers.initRepo(path.join(workspace, "api"));
  helpers.initRepo(path.join(workspace, "shared"));
  helpers.initRepo(path.join(workspace, "web"));
  installHost(workspace);

  const state = await invoke("git.state", {});

  assert.equal(state.ok, true);
  assert.equal(state.workspace.path, workspace);
  assert.deepEqual(repoNames(state), ["api", "shared", "web"]);
  assert.equal(path.resolve(state.repoRoot), path.resolve(workspace, "api"));
  assert.equal(state.inspectionError, null);
  assert.ok(state.appearance);
});

test("git.state distinguishes an empty parent folder from a missing workspace", async () => {
  const workspace = helpers.makeRoot("bridge-empty");
  helpers.makeDir(workspace, "src");
  installHost(workspace);

  const state = await invoke("git.state", {});

  assert.equal(state.workspace.path, workspace);
  assert.deepEqual(state.repositories, []);
  assert.equal(state.repoRoot, null);
  assert.equal(state.inspectionError, null);
});

test("git.state surfaces a genuine inspection error", async () => {
  const workspace = path.join(helpers.makeRoot("bridge-broken"), "does-not-exist");
  installHost(workspace);

  const state = await invoke("git.state", {});

  assert.equal(state.workspace.path, workspace);
  assert.deepEqual(state.repositories, []);
  assert.equal(state.repoRoot, null);
  assert.equal(typeof state.inspectionError, "string");
  assert.ok(state.inspectionError.length > 0);
});

test("git.state keeps a single repository workspace working", async () => {
  const workspace = helpers.makeRoot("bridge-single");
  helpers.initRepo(workspace);
  installHost(workspace);

  const state = await invoke("git.state", {});

  assert.equal(state.repositories.length, 1);
  assert.equal(path.resolve(state.repositories[0].root), path.resolve(workspace));
  assert.equal(path.resolve(state.repoRoot), path.resolve(workspace));
});

test("git.state reports a partial inspection failure as a warning next to usable repositories", async () => {
  const workspace = helpers.makeRoot("bridge-warning");
  const good = helpers.initRepo(path.join(workspace, "good"), { commit: true });
  const broken = helpers.makeDir(workspace, "broken");
  fs.writeFileSync(path.join(broken, ".git"), "garbage\n");
  installHost(workspace);

  const state = await invoke("git.state", {});

  assert.equal(state.inspectionError, null);
  assert.deepEqual(state.repositories.map((repo) => repo.name), ["good"]);
  assert.equal(path.resolve(state.repoRoot), path.resolve(good));
  assert.ok(state.inspectionWarning, "the broken candidate must not vanish silently");
  assert.equal(state.inspectionWarning.count, 1);
  assert.match(state.inspectionWarning.message, /gitfile format/i);

  const status = await invoke("git.status", { repoRoot: good });
  assert.equal(status.ok, true);
});

test("every git request must carry an allowed repoRoot", async () => {
  const workspace = helpers.makeRoot("bridge-roots");
  const ui = helpers.initRepo(path.join(workspace, "api"), { commit: true });
  const hidden = helpers.initRepo(path.join(workspace, "node_modules", "hidden"));
  installHost(workspace);

  await invoke("git.state", {});
  const uiRoot = path.resolve(ui);

  await assert.rejects(invoke("git.status", {}), /repoRoot is required/);
  await assert.rejects(
    invoke("git.status", { repoRoot: path.join(uiRoot, "src") }),
    /Unknown repository/,
  );
  await assert.rejects(
    invoke("git.status", { repoRoot: path.resolve(hidden) }),
    /Unknown repository/,
  );
  await assert.rejects(invoke("git.log", { repoRoot: path.join(workspace, "nope") }), /Unknown repository/);
  await assert.rejects(invoke("git.branch", { repoRoot: "", action: "list" }), /repoRoot is required/);

  const status = await invoke("git.status", { repoRoot: uiRoot });
  assert.equal(status.ok, true);
  assert.equal(path.resolve(status.repo), path.resolve(uiRoot));
  assert.equal(status.branch, "main");
});

test("git requests are pinned to the repository they carry", async () => {
  const workspace = helpers.makeRoot("bridge-pin");
  const alpha = helpers.initRepo(path.join(workspace, "alpha"), { commit: true, message: "alpha base" });
  const beta = helpers.initRepo(path.join(workspace, "beta"), { commit: true, message: "beta base" });
  helpers.commitFile(alpha, "alpha.txt", "a\n", "alpha only");
  helpers.commitFile(beta, "beta.txt", "b\n", "beta only");
  installHost(workspace);

  const logAlpha = await invoke("git.log", { repoRoot: alpha, count: 5 });
  const logBeta = await invoke("git.log", { repoRoot: beta, count: 5 });
  const statusBeta = await invoke("git.status", { repoRoot: beta });

  assert.equal(logAlpha.commits[0].subject, "alpha only");
  assert.equal(logBeta.commits[0].subject, "beta only");
  assert.equal(path.resolve(statusBeta.repo), path.resolve(beta));
});

test("selection is remembered but never overrides the request root", async () => {
  const workspace = helpers.makeRoot("bridge-select");
  const alpha = helpers.initRepo(path.join(workspace, "alpha"), { commit: true, message: "alpha base" });
  const beta = helpers.initRepo(path.join(workspace, "beta"), { commit: true, message: "beta base" });
  helpers.commitFile(alpha, "alpha.txt", "a\n", "alpha only");
  helpers.commitFile(beta, "beta.txt", "b\n", "beta only");
  installHost(workspace);

  const first = await invoke("git.state", {});
  assert.equal(path.resolve(first.repoRoot), path.resolve(alpha));

  const selected = await invoke("git.selectRepository", { repoRoot: beta });
  assert.equal(path.resolve(selected.repoRoot), path.resolve(beta));

  const remembered = await invoke("git.state", {});
  assert.equal(path.resolve(remembered.repoRoot), path.resolve(beta));

  // An explicitly pinned request still goes to the repository it names.
  const log = await invoke("git.log", { repoRoot: alpha, count: 5 });
  assert.equal(log.commits[0].subject, "alpha only");

  await assert.rejects(
    invoke("git.selectRepository", { repoRoot: path.join(workspace, "nope") }),
    /Unknown repository/,
  );
  await assert.rejects(invoke("git.selectRepository", {}), /repoRoot is required/);
});

test("a write stays on its captured repository after the selection switches", async () => {
  const workspace = helpers.makeRoot("bridge-write");
  const alpha = helpers.initRepo(path.join(workspace, "alpha"), { commit: true, message: "alpha base" });
  const beta = helpers.initRepo(path.join(workspace, "beta"), { commit: true, message: "beta base" });
  installHost(workspace);

  await invoke("git.state", {});
  await invoke("git.selectRepository", { repoRoot: beta });
  fs.writeFileSync(path.join(alpha, "staged.txt"), "alpha change\n");

  // A confirmation dialog captured alpha before the switch; it must not write
  // into the newly selected beta repository.
  const result = await invoke("git.commit", {
    repoRoot: alpha,
    message: "captured alpha write",
    stage: "all",
  });

  assert.equal(path.resolve(result.repo), path.resolve(alpha));
  assert.equal(path.resolve(result.status.repo), path.resolve(alpha));

  const alphaLog = await invoke("git.log", { repoRoot: alpha, count: 5 });
  const betaLog = await invoke("git.log", { repoRoot: beta, count: 5 });
  assert.equal(alphaLog.commits[0].subject, "captured alpha write");
  assert.ok(!betaLog.commits.some((commit) => commit.subject === "captured alpha write"));
});

test("post-commit status is pinned to the committed repository", async () => {
  const workspace = helpers.makeRoot("bridge-status");
  const alpha = helpers.initRepo(path.join(workspace, "alpha"), { commit: true, message: "alpha base" });
  helpers.initRepo(path.join(workspace, "beta"), { commit: true, message: "beta base" });
  installHost(workspace);
  await invoke("git.state", {});
  fs.writeFileSync(path.join(alpha, "one.txt"), "1\n");

  const result = await invoke("git.commit", { repoRoot: alpha, message: "one", stage: "all" });

  assert.equal(path.resolve(result.status.repo), path.resolve(alpha));
  assert.equal(result.status.workspace, workspace);
  assert.equal(result.status.untracked.length, 0);
});

test("branch listing runs against the requested repository", async () => {
  const workspace = helpers.makeRoot("bridge-branch");
  const alpha = helpers.initRepo(path.join(workspace, "alpha"), { commit: true, message: "alpha base" });
  helpers.initRepo(path.join(workspace, "beta"), { commit: true, message: "beta base" });
  installHost(workspace);
  await invoke("git.state", {});

  const list = await invoke("git.branch", { repoRoot: alpha, action: "list" });

  assert.equal(list.ok, true);
  assert.equal(path.resolve(list.repo), path.resolve(alpha));
  assert.equal(list.current, "main");
  assert.deepEqual(list.branches.map((branch) => branch.name), ["main"]);
});

test("git.refreshRepositories rescans after a repository appears", async () => {
  const workspace = helpers.makeRoot("bridge-refresh");
  helpers.initRepo(path.join(workspace, "api"));
  installHost(workspace);

  const before = await invoke("git.state", {});
  assert.deepEqual(repoNames(before), ["api"]);

  helpers.initRepo(path.join(workspace, "web"));

  const cached = await invoke("git.state", {});
  assert.deepEqual(repoNames(cached), ["api"]);

  const refreshed = await invoke("git.refreshRepositories", {});
  assert.deepEqual(repoNames(refreshed), ["api", "web"]);
  assert.equal(path.resolve(refreshed.repoRoot), path.resolve(workspace, "api"));
});

test("git.state keeps the requested panel view", async () => {
  const workspace = helpers.makeRoot("bridge-panelstate");
  helpers.initRepo(workspace);
  installHost(workspace);
  await impl().onLoad();

  const state = await invoke("git.state", {});

  assert.equal(state.ok, true);
  assert.ok(state.state === null || typeof state.state === "object");
});
