// The mod builds Worker against a GitHub that is a table in memory: `node --test`.
import assert from "node:assert/strict";
import test from "node:test";
import { buildKey, handle, readMods, WORKFLOW } from "./worker.js";

const REPO = "someone/horizon-pocket-edition-ios";
const TAG = "v1.1.0-shared-worlds-mods";
const DEVICE = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-11-24T12:00:00Z");

/// A KV namespace: `get` and `put` over a Map, the lifetimes noted.
function store() {
  const map = new Map();
  return {
    map,
    ttl: new Map(),
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, value, options) {
      map.set(key, value);
      this.ttl.set(key, options?.expirationTtl);
    },
  };
}

/// GitHub's API for one repository: its artifacts, its workflow's runs, and what was asked of it.
function github({ artifacts = [], runs = [], jobs = {}, dispatch = 204 } = {}) {
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    asked.push({ method: init.method ?? "GET", pathname, body: init.body, init });
    assert.equal(init.headers.authorization, "Bearer token");
    const base = `/repos/${REPO}/actions`;
    if (pathname === `${base}/artifacts`) {
      const name = searchParams.get("name");
      return Response.json({ artifacts: artifacts.filter((a) => a.name === name) });
    }
    if (pathname === `${base}/workflows/${WORKFLOW}/runs`) {
      return Response.json({ workflow_runs: runs });
    }
    if (pathname === `${base}/workflows/${WORKFLOW}/dispatches`) {
      return new Response(null, { status: dispatch });
    }
    const job = /\/runs\/(\d+)\/jobs$/.exec(pathname);
    if (job) return Response.json({ jobs: jobs[job[1]] ?? [] });
    const zip = /\/artifacts\/(\d+)\/zip$/.exec(pathname);
    if (zip) {
      assert.equal(init.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: `https://files.example/${zip[1]}?sig=short` },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetcher, asked };
}

const env = (more = {}) => ({ REPO, GITHUB_TOKEN: "token", LIMITS: store(), ...more });

const post = (body) =>
  new Request("https://builds.example/v1/build", { method: "POST", body: JSON.stringify(body) });

const get = (path) => new Request(`https://builds.example${path}`);

const asking = (mods = ["waymap@1.2.0", "appleskin@3.0.1"], more = {}) =>
  post({ tag: TAG, mods, device: DEVICE, ...more });

test("the same mods in any order are the same build", async () => {
  const a = readMods(["waymap@1.2.0", "appleskin@3.0.1"], 24).mods;
  const b = readMods(["appleskin@3.0.1", "waymap@1.2.0"], 24).mods;
  assert.deepEqual(a, ["appleskin@3.0.1", "waymap@1.2.0"]);
  assert.deepEqual(a, b);
  assert.equal(await buildKey(TAG, a), await buildKey(TAG, b));
  assert.match(await buildKey(TAG, a), /^[0-9a-f]{24}$/);
  // Another edition, another version of a mod: another build.
  assert.notEqual(await buildKey(TAG, a), await buildKey("v1.1.0", a));
  assert.notEqual(await buildKey(TAG, a), await buildKey(TAG, ["appleskin@3.0.2", "waymap@1.2.0"]));
});

test("what is not a catalog mod is refused before GitHub hears of it", async () => {
  const { fetcher, asked } = github();
  for (const mods of [
    [],
    "waymap@1.2.0",
    ["waymap"],
    ["Waymap@1.2.0"],
    ["waymap@1.2.0; rm -rf /"],
    ["../waymap@1"],
    ["waymap@1.2.0", "waymap@1.3.0"],
    Array.from({ length: 25 }, (_, i) => `mod${i}@1`),
  ]) {
    const response = await handle(asking(mods), env(), fetcher, NOW);
    assert.equal(response.status, 400, JSON.stringify(mods));
    assert.ok((await response.json()).error);
  }
  for (const body of [
    { tag: "main", mods: ["waymap@1"], device: DEVICE },
    { tag: "v1.1.0-other", mods: ["waymap@1"], device: DEVICE },
    { tag: TAG, mods: ["waymap@1"], device: "me" },
    { tag: TAG, mods: ["waymap@1"] },
  ]) {
    assert.equal((await handle(post(body), env(), fetcher, NOW)).status, 400);
  }
  const broken = new Request("https://builds.example/v1/build", { method: "POST", body: "{" });
  assert.equal((await handle(broken, env(), fetcher, NOW)).status, 400);
  assert.equal(asked.length, 0);
});

test("a new build is started once, at the release's own tag", async () => {
  const { fetcher, asked } = github();
  const e = env();
  const response = await handle(asking(), e, fetcher, NOW);
  assert.equal(response.status, 202);
  const { key, state } = await response.json();
  assert.equal(state, "queued");
  assert.equal(key, await buildKey(TAG, ["appleskin@3.0.1", "waymap@1.2.0"]));
  const started = asked.filter((a) => a.method === "POST");
  assert.equal(started.length, 1);
  assert.deepEqual(JSON.parse(started[0].body), {
    ref: TAG,
    inputs: { mods: "appleskin@3.0.1,waymap@1.2.0", key },
  });
  // Counted for the device and for the day, and remembered for the moment GitHub takes to list it.
  assert.equal(e.LIMITS.map.get(`d:2026-11-24:${DEVICE}`), "1");
  assert.equal(e.LIMITS.map.get("g:2026-11-24"), "1");
  assert.equal(e.LIMITS.map.get(`k:${key}`), "1");
  // Asked again a moment later (GitHub lists no run yet): the same build, not a second one.
  const again = await handle(asking(["waymap@1.2.0", "appleskin@3.0.1"]), e, fetcher, NOW + 5000);
  assert.deepEqual(await again.json(), { key, state: "queued" });
  assert.equal(asked.filter((a) => a.method === "POST").length, 1);
  assert.equal(e.LIMITS.map.get(`d:2026-11-24:${DEVICE}`), "1");
});

test("a build under way or finished is found, not started again", async () => {
  const key = await buildKey(TAG, ["appleskin@3.0.1", "waymap@1.2.0"]);
  const running = github({
    runs: [
      { id: 7, display_title: "mod-build 000000000000000000000000", status: "completed" },
      {
        id: 8,
        display_title: `mod-build ${key}`,
        status: "in_progress",
        run_started_at: "2026-11-24T11:50:00Z",
      },
    ],
  });
  const during = await handle(asking(), env(), running.fetcher, NOW);
  assert.deepEqual(await during.json(), {
    key,
    state: "building",
    since: "2026-11-24T11:50:00Z",
  });
  assert.equal(running.asked.filter((a) => a.method === "POST").length, 0);

  const done = github({
    artifacts: [
      { id: 41, name: `mod-build-${key}`, expired: true, created_at: "2026-11-01T00:00:00Z" },
      {
        id: 42,
        name: `mod-build-${key}`,
        expired: false,
        created_at: "2026-11-24T11:58:00Z",
        size_in_bytes: 123456789,
        expires_at: "2026-12-01T11:58:00Z",
      },
    ],
  });
  const ready = await handle(asking(), env(), done.fetcher, NOW);
  assert.deepEqual(await ready.json(), {
    key,
    state: "ready",
    size: 123456789,
    expires: "2026-12-01T11:58:00Z",
  });
  assert.equal(done.asked.filter((a) => a.method === "POST").length, 0);
  // Its file: GitHub's own link, handed on.
  const link = await handle(get(`/v1/build/${key}/ipa`), env(), done.fetcher, NOW);
  assert.equal(link.status, 302);
  assert.equal(link.headers.get("location"), "https://files.example/42?sig=short");
});

test("a failed build says where it failed and waits an hour", async () => {
  const key = await buildKey(TAG, ["appleskin@3.0.1", "waymap@1.2.0"]);
  const failed = (updated) =>
    github({
      runs: [
        {
          id: 9,
          display_title: `mod-build ${key}`,
          status: "completed",
          conclusion: "failure",
          updated_at: updated,
        },
      ],
      jobs: {
        9: [
          { conclusion: "success", steps: [{ name: "Check the request", conclusion: "success" }] },
          { conclusion: "failure", steps: [{ name: "Build the game", conclusion: "failure" }] },
        ],
      },
    });
  const fresh = failed("2026-11-24T11:40:00Z");
  const told = await handle(asking(), env(), fresh.fetcher, NOW);
  assert.deepEqual(await told.json(), {
    key,
    state: "failed",
    since: "2026-11-24T11:40:00Z",
    reason: "The build failed at: Build the game.",
  });
  assert.equal(fresh.asked.filter((a) => a.method === "POST").length, 0);
  // The app reads the same.
  const read = await handle(get(`/v1/build/${key}`), env(), fresh.fetcher, NOW);
  assert.equal((await read.json()).state, "failed");
  // An hour on, asking again tries again.
  const old = failed("2026-11-24T10:30:00Z");
  const retried = await handle(asking(), env(), old.fetcher, NOW);
  assert.equal(retried.status, 202);
  assert.equal(old.asked.filter((a) => a.method === "POST").length, 1);
});

test("a device and a day have only so many builds", async () => {
  const { fetcher, asked } = github();
  const e = env({ PER_DEVICE_PER_DAY: "2", PER_DAY: "3" });
  const build = (n, device = DEVICE) =>
    handle(post({ tag: TAG, mods: [`mod${n}@1`], device }), e, fetcher, NOW);
  assert.equal((await build(1)).status, 202);
  assert.equal((await build(2)).status, 202);
  const third = await build(3);
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /2 builds today/);
  // Another device has its own, until the day's are gone.
  const other = "f".repeat(32);
  assert.equal((await build(4, other)).status, 202);
  assert.equal((await build(5, other)).status, 429);
  assert.equal(asked.filter((a) => a.method === "POST").length, 3);
  // Tomorrow there are more.
  const tomorrow = await handle(
    post({ tag: TAG, mods: ["mod6@1"], device: DEVICE }),
    e,
    fetcher,
    NOW + 24 * 60 * 60 * 1000,
  );
  assert.equal(tomorrow.status, 202);
});

test("a build nobody made, a wrong address and a service not set up say so", async () => {
  const { fetcher } = github();
  const none = await handle(get(`/v1/build/${"0".repeat(24)}`), env(), fetcher, NOW);
  assert.deepEqual(await none.json(), { key: "0".repeat(24), state: "none" });
  assert.equal((await handle(get(`/v1/build/${"0".repeat(24)}/ipa`), env(), fetcher, NOW)).status, 404);
  assert.equal((await handle(get("/v1/build/not-a-key"), env(), fetcher, NOW)).status, 400);
  assert.equal((await handle(get("/v1/other"), env(), fetcher, NOW)).status, 404);
  assert.equal((await handle(get("/v1/build"), env(), fetcher, NOW)).status, 405);
  assert.equal((await handle(get("/"), env(), fetcher, NOW)).status, 200);
  // No token, no repository, no counters: nothing is started.
  assert.equal((await handle(asking(), { REPO }, fetcher, NOW)).status, 503);
  assert.equal((await handle(asking(), { GITHUB_TOKEN: "token" }, fetcher, NOW)).status, 503);
  const uncounted = await handle(asking(), { REPO, GITHUB_TOKEN: "token" }, fetcher, NOW);
  assert.equal(uncounted.status, 503);
  // A tag the repository has no workflow at.
  const missing = github({ dispatch: 422 });
  const refused = await handle(asking(), env(), missing.fetcher, NOW);
  assert.equal(refused.status, 400);
  // GitHub down: said, not hidden.
  const down = async () => new Response("no", { status: 500 });
  assert.equal((await handle(asking(), env(), down, NOW)).status, 502);
});
