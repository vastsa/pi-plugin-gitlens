"use strict";

/* Git Lens renderer — repository selection guard.
 *
 * Loaded before panel.js. A workspace can host several repositories, so every
 * panel request, confirmation closure and late bridge response has to stay
 * bound to the repository that was selected when it was created:
 *
 *   const guard = window.__gitlensSelection.createRepositoryGuard();
 *   guard.setRoot(root);                       // bumps generation
 *   const gen = guard.generation;              // capture at render time
 *   const pinned = createPinnedChannel({ guard, invoke });
 *   pinned(gen, "git.status", {});             // rejected if gen is stale
 *
 * `setRoot` returns false when the repository did not actually change, so a
 * poll that repeats the same selection never invalidates in-flight work.
 * `rootFor(generation)` keeps the root captured for an older generation, which
 * is what makes a stale write impossible: the pinned channel refuses to invoke
 * at all once the generation moved on.
 */
(function initGitLensSelection(global) {
  "use strict";

  function staleError(message) {
    const error = new Error(message || "response belongs to a previous repository");
    error.name = "StaleResponse";
    error.stale = true;
    return error;
  }

  function isStaleError(error) {
    return Boolean(error && (error.stale === true || error.name === "StaleResponse"));
  }

  function createRepositoryGuard() {
    let root = null;
    let generation = 0;
    const roots = new Map([[0, null]]);

    return {
      get root() {
        return root;
      },
      get generation() {
        return generation;
      },
      /** Select a repository; true only when the selection actually changed. */
      setRoot(next) {
        const value = typeof next === "string" && next ? next : null;
        if (value === root) return false;
        root = value;
        generation += 1;
        roots.set(generation, root);
        return true;
      },
      rootFor(requestGeneration) {
        return roots.has(requestGeneration) ? roots.get(requestGeneration) : null;
      },
      isCurrent(requestGeneration) {
        return requestGeneration === generation;
      },
      scope() {
        return { generation, root };
      },
      staleError,
    };
  }

  /**
   * Wrap a bridge invoke so each request carries the repoRoot captured for its
   * generation, is rejected before it is sent when that generation is stale,
   * and is rejected after it resolves when the user switched meanwhile.
   */
  function createPinnedChannel({ guard, invoke } = {}) {
    if (!guard || typeof guard.isCurrent !== "function" || typeof guard.rootFor !== "function") {
      throw new TypeError("createPinnedChannel requires a repository guard");
    }
    if (typeof invoke !== "function") {
      throw new TypeError("createPinnedChannel requires an invoke function");
    }

    return function pinnedRequest(generation, channel, payload) {
      if (!guard.isCurrent(generation)) return Promise.reject(guard.staleError());
      const repoRoot = guard.rootFor(generation);
      if (!repoRoot) return Promise.reject(guard.staleError("no repository is selected"));

      let request;
      try {
        request = invoke(channel, Object.assign({}, payload || {}, { repoRoot }));
      } catch (error) {
        return Promise.reject(error);
      }

      return Promise.resolve(request).then((result) => {
        if (!guard.isCurrent(generation)) throw guard.staleError();
        if (result && typeof result === "object" && result.ok === false) {
          throw new Error(result.error || "operation failed");
        }
        return result;
      });
    };
  }

  const api = {
    createRepositoryGuard,
    createPinnedChannel,
    isStaleError,
    staleError,
  };

  if (global) global.__gitlensSelection = api;
})(typeof window !== "undefined" ? window : null);
