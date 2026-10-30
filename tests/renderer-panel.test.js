"use strict";

/* Panel renderer smoke test.
 *
 * renderer/panel.js is loaded in a VM with a minimal DOM stub so the whole
 * render path runs (init → overview → repository switch). It proves the two
 * properties the multi-repository UI depends on:
 *   - only repositories reported by git.state are offered, and only when the
 *     workspace really has more than one;
 *   - a response that belongs to the repository the user just left can neither
 *     paint the header nor disturb the new view.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RENDERER = path.join(__dirname, "..", "renderer");

const WORKSPACE = "/work/project";
const UI = "/work/project/api";
const FRONT = "/work/project/web";

class FakeClassList {
  constructor() {
    this.names = new Set();
  }

  add(...names) {
    for (const name of names) this.names.add(name);
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
  }

  contains(name) {
    return this.names.has(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList();
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this._text = "";
    this._html = "";
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._text = value === undefined || value === null ? "" : String(value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value);
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "hidden") this.hidden = true;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  async dispatch(type, event) {
    for (const handler of this.listeners[type] || []) await handler(event || {});
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

function buildDom() {
  const nodes = new Map();
  const document = {
    documentElement: new FakeNode("html"),
    head: new FakeNode("head"),
    body: new FakeNode("body"),
    title: "",
    hidden: false,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new FakeNode("div"));
      return nodes.get(id);
    },
    createElement(tag) {
      return new FakeNode(tag);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  document.documentElement.lang = "en";
  document.documentElement.dataset = {};
  // index.html ships the banner and the repository select hidden.
  nodes.set("banner", Object.assign(new FakeNode("div"), { hidden: true }));
  nodes.set("repoSelect", Object.assign(new FakeNode("select"), { hidden: true }));
  return { document, nodes };
}

function flush(times = 25) {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) chain = chain.then(() => {});
  return chain.then(() => new Promise((resolve) => setImmediate(resolve)));
}

/**
 * Boot the renderer scripts the way index.html does:
 * appearance-boot.js → appearance.js → selection.js → panel.js.
 *
 * `pending` collects every deferred request so a test can resolve responses out
 * of order; `timers` exposes the panel's one-second poll (and the appearance
 * poll) so overlap can be provoked deterministically.
 */
function bootPanel(stateSource, options = {}) {
  const { deferState = false, appearance = null } = options;
  const { document, nodes } = buildDom();
  const calls = [];
  const pending = new Map();
  const storage = new Map();
  const timers = [];

  const slot = (channel) => {
    if (!pending.has(channel)) pending.set(channel, []);
    return pending.get(channel);
  };
  const defer = (channel, args) =>
    new Promise((resolve, reject) => {
      slot(channel).push({ payload: args, resolve, reject });
    });
  const isStateChannel = (channel) =>
    channel === "git.state" ||
    channel === "git.refreshRepositories" ||
    channel === "git.selectRepository";

  const win = {
    pluginBridge: {
      invoke(channel, payload) {
        const args = payload || {};
        calls.push({ channel, payload: { ...args } });
        if (channel === "app.getAppearance") return Promise.resolve(appearance);
        if (isStateChannel(channel) && !deferState) {
          return Promise.resolve(stateSource(channel));
        }
        return defer(channel, args);
      },
      on() {},
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    setInterval(handler, ms) {
      timers.push({ handler, ms });
      return timers.length;
    },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    document,
  };
  win.window = win;

  const sandbox = {
    window: win,
    document,
    localStorage: win.localStorage,
    setTimeout,
    clearTimeout,
    setInterval: win.setInterval,
    console,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const script of ["appearance-boot.js", "appearance.js", "selection.js", "panel.js"]) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, script), "utf8"), context, {
      filename: `renderer/${script}`,
    });
  }

  const poll = () => {
    const timer = timers.find((entry) => entry.ms === 1000);
    if (timer) timer.handler();
    return flush();
  };

  return { win, document, nodes, calls, pending, storage, timers, poll, flush };
}

function stateResponse() {
  return {
    ok: true,
    state: null,
    workspace: { path: WORKSPACE, name: "project" },
    workspaceKey: WORKSPACE,
    repositories: [
      { root: UI, name: "api", relativePath: "api", primary: false },
      { root: FRONT, name: "web", relativePath: "web", primary: false },
    ],
    repoRoot: UI,
    repositoriesCached: false,
    repositoriesTruncated: false,
    inspectionError: null,
    appearance: null,
  };
}

const statusPayload = (branch) => ({
  ok: true,
  repo: branch === "branch-main" ? UI : FRONT,
  workspace: WORKSPACE,
  branch,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicts: [],
  truncated: false,
});

test("panel offers the discovered repositories and pins requests after a switch", async () => {
  const panel = bootPanel(stateResponse);
  await flush();

  const banner = panel.document.getElementById("banner");
  assert.equal(banner.hidden, true, `unexpected banner: ${banner.textContent}`);
  const select = panel.document.getElementById("repoSelect");
  assert.equal(select.hidden, false);
  assert.deepEqual(select.children.map((option) => option.value), [UI, FRONT]);
  assert.equal(select.value, UI);

  const initialStatus = [...(panel.pending.get("git.status") || [])];
  const initialLog = [...(panel.pending.get("git.log") || [])];
  assert.ok(initialStatus.length >= 1, "the overview must request status");
  for (const request of initialStatus) assert.equal(request.payload.repoRoot, UI);

  // Switch repository the way the header selector does.
  select.value = FRONT;
  await select.dispatch("change");
  await flush();

  const after = panel.calls.filter((call) => call.channel === "git.status" || call.channel === "git.log");
  const firstNew = after.findIndex((call) => call.payload.repoRoot === FRONT);
  assert.ok(firstNew >= 0, "the new repository must be queried after the switch");
  for (const call of after.slice(firstNew)) assert.equal(call.payload.repoRoot, FRONT);
  assert.ok(
    panel.calls.some((call) => call.channel === "git.selectRepository" && call.payload.repoRoot === FRONT),
    "the plugin selection must follow the header selector",
  );

  const frontStatus = (panel.pending.get("git.status") || []).filter(
    (request) => request.payload.repoRoot === FRONT,
  );
  assert.ok(frontStatus.length >= 1);
  for (const request of frontStatus) request.resolve(statusPayload("branch-front"));
  for (const request of panel.pending.get("git.log") || []) {
    request.resolve({ ok: true, repo: request.payload.repoRoot, count: 0, commits: [] });
  }
  await flush();

  // The api responses land last: they must not repaint anything.
  for (const request of initialLog) {
    request.resolve({ ok: true, repo: UI, count: 0, commits: [] });
  }
  for (const request of initialStatus) request.resolve(statusPayload("branch-main"));
  await flush();

  assert.equal(panel.document.getElementById("branchChip").textContent, "branch-front");
  assert.equal(select.value, FRONT);
});

test("panel keeps a single repository free of selector chrome", async () => {
  const panel = bootPanel(() => ({
    ...stateResponse(),
    repositories: [{ root: UI, name: "api", relativePath: ".", primary: true }],
    repoRoot: UI,
  }));
  await flush();

  const select = panel.document.getElementById("repoSelect");
  assert.equal(select.hidden, true);
  assert.equal(select.value, UI);

  for (const request of panel.pending.get("git.status") || []) {
    request.resolve(statusPayload("branch-main"));
  }
  for (const request of panel.pending.get("git.log") || []) {
    request.resolve({ ok: true, repo: UI, count: 0, commits: [] });
  }
  await flush();
  assert.equal(panel.document.getElementById("banner").hidden, true);
});

test("panel distinguishes an empty workspace from an inspection error", async () => {
  const empty = bootPanel(() => ({
    ...stateResponse(),
    repositories: [],
    repoRoot: null,
    inspectionError: null,
  }));
  await flush();
  assert.match(empty.document.getElementById("banner").textContent, /No git repositories found/);

  const broken = bootPanel(() => ({
    ...stateResponse(),
    repositories: [],
    repoRoot: null,
    inspectionError: "Failed to inspect git repositories: spawn git ENOENT",
  }));
  await flush();
  const banner = broken.document.getElementById("banner");
  assert.match(banner.textContent, /spawn git ENOENT/);
  assert.equal(banner.hidden, false);
});

test("index.html loads its renderer scripts in order and they all exist", () => {
  const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  const sources = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);

  const expected = ["appearance-boot.js", "appearance.js", "selection.js", "panel.js"];
  for (const script of expected) {
    assert.ok(
      sources.some((source) => source.endsWith(script)),
      `${script} must be referenced by index.html`,
    );
    assert.ok(fs.existsSync(path.join(RENDERER, script)), `${script} must exist`);
  }

  const order = expected.map((script) => sources.findIndex((source) => source.endsWith(script)));
  assert.deepEqual(
    [...order].sort((left, right) => left - right),
    order,
    `scripts must load appearance-boot → appearance → selection → panel (got ${sources.join(", ")})`,
  );
});

test("panel boots the appearance adapter from index.html order", async () => {
  const panel = bootPanel(stateResponse, {
    appearance: { base: "dark", theme: "dark", locale: "zh-CN" },
  });
  await flush();

  const appearance = panel.win.__appearance;
  assert.ok(appearance, "appearance.js must publish window.__appearance");
  assert.equal(appearance.__state.started, true, "panel.js must call appearance.init");
  assert.equal(appearance.current().base, "dark");
  assert.equal(panel.document.documentElement.dataset.theme, "dark");
  assert.equal(panel.document.documentElement.lang, "zh-CN");
});

test("panel shows a localized warning next to usable repositories", async () => {
  const panel = bootPanel(() => ({
    ...stateResponse(),
    inspectionWarning: { count: 1, message: "fatal: Invalid gitfile format" },
  }));
  await flush();

  const banner = panel.document.getElementById("banner");
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /Some repositories could not be inspected/);
  assert.match(banner.textContent, /Invalid gitfile format/);

  const select = panel.document.getElementById("repoSelect");
  assert.equal(select.hidden, false);
  assert.deepEqual(select.children.map((option) => option.value), [UI, FRONT]);
});

test("a slow older git.state response cannot override a newer one", async () => {
  const panel = bootPanel(stateResponse, { deferState: true });
  const initial = panel.pending.get("git.state");
  assert.equal(initial.length, 1, "init must issue one git.state request");
  initial[0].resolve(stateResponse());
  await flush();

  const select = panel.document.getElementById("repoSelect");
  assert.equal(select.children.length, 2);

  // Two overlapping polls; the newer one is answered first.
  panel.poll();
  panel.poll();
  const requests = panel.pending.get("git.state");
  const older = requests[1];
  const newer = requests[2];
  newer.resolve(stateResponse());
  await flush();
  older.resolve({
    ...stateResponse(),
    repositories: [{ root: UI, name: "api", relativePath: ".", primary: true }],
  });
  await flush();

  assert.equal(select.children.length, 2, "the older response must be ignored");
  assert.equal(select.hidden, false);
  assert.equal(panel.document.getElementById("banner").hidden, true);
});

test("an older select echo cannot override a newer state response", async () => {
  const panel = bootPanel(stateResponse, { deferState: true });
  panel.pending.get("git.state")[0].resolve(stateResponse());
  await flush();

  const select = panel.document.getElementById("repoSelect");
  select.value = FRONT;
  await select.dispatch("change");
  await flush();
  assert.equal(select.value, FRONT);

  // A poll issued after the switch is answered first...
  panel.poll();
  const pollRequest = panel.pending.get("git.state").at(-1);
  pollRequest.resolve(stateResponse());
  await flush();
  assert.deepEqual(select.children.map((option) => option.value), [UI, FRONT]);
  assert.equal(select.value, FRONT);

  // ...then the older select echo lands with a state that no longer lists the
  // newly selected repository. It must not pull the panel back.
  const echoes = panel.pending.get("git.selectRepository");
  assert.equal(echoes.length, 1);
  echoes[0].resolve({
    ...stateResponse(),
    repositories: [{ root: UI, name: "api", relativePath: ".", primary: true }],
  });
  await flush();

  assert.equal(select.value, FRONT);
  assert.deepEqual(select.children.map((option) => option.value), [UI, FRONT]);
});
