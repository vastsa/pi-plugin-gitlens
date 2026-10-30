"use strict";

/* Renderer-side switch isolation tests.
 *
 * renderer/selection.js is the generation guard the panel renderer uses to pin
 * every git request to the repository that was selected when the request (or a
 * confirmation closure) was created. It is loaded in a VM with a stub
 * `window`, exactly like the panel does, so no DOM or Electron is required.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SELECTION_PATH = path.join(__dirname, "..", "renderer", "selection.js");

function loadSelectionApi() {
  const code = fs.readFileSync(SELECTION_PATH, "utf8");
  const stubWindow = {};
  const context = vm.createContext({ window: stubWindow, setTimeout, clearTimeout, console });
  vm.runInContext(code, context, { filename: "renderer/selection.js" });
  const api = stubWindow.__gitlensSelection;
  assert.ok(api, "renderer/selection.js must publish window.__gitlensSelection");
  return api;
}

test("loads the selection guard from the renderer script", () => {
  const api = loadSelectionApi();

  assert.equal(typeof api.createRepositoryGuard, "function");
  assert.equal(typeof api.createPinnedChannel, "function");
  assert.equal(typeof api.isStaleError, "function");
});

test("guard bumps its generation only when the repository really changes", () => {
  const { createRepositoryGuard } = loadSelectionApi();
  const guard = createRepositoryGuard();

  assert.equal(guard.root, null);
  assert.equal(guard.generation, 0);
  assert.equal(guard.setRoot("/work/project/api"), true);
  assert.equal(guard.generation, 1);
  assert.equal(guard.root, "/work/project/api");
  assert.equal(guard.setRoot("/work/project/api"), false);
  assert.equal(guard.generation, 1);
  assert.equal(guard.setRoot("/work/project/web"), true);
  assert.equal(guard.generation, 2);
  assert.equal(guard.isCurrent(1), false);
  assert.equal(guard.isCurrent(2), true);
});

test("guard remembers the root captured for an older generation", () => {
  const { createRepositoryGuard } = loadSelectionApi();
  const guard = createRepositoryGuard();
  guard.setRoot("A");
  const captured = guard.scope();
  guard.setRoot("B");

  assert.deepEqual({ ...captured }, { generation: 1, root: "A" });
  assert.equal(guard.rootFor(1), "A");
  assert.equal(guard.rootFor(guard.generation), "B");
  assert.equal(guard.isCurrent(captured.generation), false);
});

test("staleError is tagged so panels can ignore it", () => {
  const { createRepositoryGuard, isStaleError } = loadSelectionApi();
  const guard = createRepositoryGuard();
  const stale = guard.staleError();

  assert.equal(isStaleError(stale), true);
  assert.equal(stale.name, "StaleResponse");
  assert.equal(isStaleError(new Error("real failure")), false);
  assert.equal(isStaleError(null), false);
});

test("pinned requests carry the repository captured with their generation", async () => {
  const { createRepositoryGuard, createPinnedChannel } = loadSelectionApi();
  const guard = createRepositoryGuard();
  const calls = [];
  const pinned = createPinnedChannel({
    guard,
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      return { ok: true };
    },
  });

  guard.setRoot("A");
  const generation = guard.generation;
  await pinned(generation, "git.status", { path: "src" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.repoRoot, "A");
  assert.equal(calls[0].payload.path, "src");
});

test("a response that arrives after a switch is rejected as stale", async () => {
  const { createRepositoryGuard, createPinnedChannel, isStaleError } = loadSelectionApi();
  const guard = createRepositoryGuard();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const pinned = createPinnedChannel({ guard, invoke: () => pending });

  guard.setRoot("A");
  const request = pinned(guard.generation, "git.log", { count: 5 });
  guard.setRoot("B");
  release({ ok: true, commits: [{ subject: "from A" }] });

  await assert.rejects(request, (error) => isStaleError(error));
});

test("a stale confirmation closure cannot write into the new repository", async () => {
  const { createRepositoryGuard, createPinnedChannel, isStaleError } = loadSelectionApi();
  const guard = createRepositoryGuard();
  let writes = 0;
  const pinned = createPinnedChannel({
    guard,
    invoke: async () => {
      writes += 1;
      return { ok: true };
    },
  });

  guard.setRoot("A");
  // A delete-branch confirmation captured A and is armed for 3s.
  const capturedGeneration = guard.generation;
  guard.setRoot("B");
  const submit = () => pinned(capturedGeneration, "git.branch", { action: "delete", name: "old" });

  await assert.rejects(submit(), (error) => isStaleError(error));
  assert.equal(writes, 0);
});

test("bridge failures stay real errors for the current repository", async () => {
  const { createRepositoryGuard, createPinnedChannel, isStaleError } = loadSelectionApi();
  const guard = createRepositoryGuard();
  const pinned = createPinnedChannel({
    guard,
    invoke: async () => ({ ok: false, error: "Unknown repository: C:/nope" }),
  });

  guard.setRoot("A");

  await assert.rejects(pinned(guard.generation, "git.status", {}), (error) => {
    assert.equal(isStaleError(error), false);
    assert.match(error.message, /Unknown repository/);
    return true;
  });
});

test("only responses from the current selection may paint", async () => {
  const { createRepositoryGuard, createPinnedChannel, isStaleError } = loadSelectionApi();
  const guard = createRepositoryGuard();
  const painted = [];
  const resolvers = [];
  const pinned = createPinnedChannel({
    guard,
    invoke: (channel, payload) => new Promise((resolve) => {
      resolvers.push({ payload, resolve });
    }),
  });

  guard.setRoot("A");
  const slowA = pinned(guard.generation, "git.log", {});
  guard.setRoot("B");
  const fastB = pinned(guard.generation, "git.log", {});

  // B's response lands first, then A's late response.
  resolvers[1].resolve({ ok: true, commits: [{ subject: "B commit" }] });
  resolvers[0].resolve({ ok: true, commits: [{ subject: "A commit" }] });

  await fastB.then(
    (result) => painted.push(result.commits[0].subject),
    () => {},
  );
  await slowA.then(
    (result) => painted.push(result.commits[0].subject),
    (error) => {
      assert.equal(isStaleError(error), true);
    },
  );

  assert.deepEqual(painted, ["B commit"]);
});
