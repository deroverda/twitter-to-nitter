// Exercises the pure decision logic in background.js.
//
// background.js is a browser script: it touches `browser.*` at load and calls
// init() at the bottom. We run it in a vm context with those stubbed, then read
// the functions back through an epilogue appended to the same source (so the
// epilogue shares scope with the script's top-level const/function bindings).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const manifest = JSON.parse(
    readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
);
const SRC = readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

const EXPORTS = [
    "originOf", "isRedirectablePath", "isHardFailure", "parseStatus",
    "sameAttempt", "candidateOrigins", "freshStatusHosts", "recordLocal",
    "PERMITTED_ORIGINS", "PERMITTED_DOMAINS", "SEED_INSTANCES"
];

function load() {
    const noop = () => {};
    const listener = { addListener: noop, removeListener: noop, hasListener: () => false };
    const ctx = {
        console: { log: noop, warn: noop, error: noop },
        setTimeout: () => 0,
        clearTimeout: noop,
        setInterval: () => 0,
        clearInterval: noop,
        URL,
        AbortController: class { constructor() { this.signal = {}; } abort() {} },
        fetch: () => Promise.reject(new Error("no network in test")),
        browser: {
            runtime: { getManifest: () => manifest },
            webRequest: {
                onBeforeRequest: listener,
                onCompleted: listener,
                onErrorOccurred: listener
            },
            tabs: {
                onRemoved: listener,
                get: async () => ({}),
                update: async () => ({}),
                executeScript: async () => [false]
            },
            storage: {
                local: {
                    get: async () => ({}),
                    set: async () => {},
                    remove: async () => {}
                }
            }
        }
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    const epilogue = `\n;globalThis.__t = { ${EXPORTS.join(", ")},
        setStatus: (hosts, fetchedAt) => { statusHosts = hosts; statusFetchedAt = fetchedAt; },
        getLocalHealth: () => localHealth };`;
    vm.runInContext(SRC + epilogue, ctx);
    return ctx.__t;
}

const bg = load();

test("originOf accepts permitted origins, rejects everything else", () => {
    assert.equal(bg.originOf("https://nitter.kareem.one/jack"), "https://nitter.kareem.one");
    assert.equal(bg.originOf("https://nitter.kareem.one/i/status/20?x=1"), "https://nitter.kareem.one");
    assert.equal(bg.originOf("https://evil.example/jack"), null);
    assert.equal(bg.originOf("https://status.d420.de/api/v1/instances"), null);
    assert.equal(bg.originOf("not a url"), null);
});

test("isRedirectablePath passes profiles and status permalinks, blocks X-only surfaces", () => {
    assert.equal(bg.isRedirectablePath("/jack"), true);
    assert.equal(bg.isRedirectablePath("/jack/status/20"), true);
    assert.equal(bg.isRedirectablePath("/i/status/20"), true);
    assert.equal(bg.isRedirectablePath("/i/web/status/20"), true);
    assert.equal(bg.isRedirectablePath("/home"), false);
    assert.equal(bg.isRedirectablePath("/settings/profile"), false);
    assert.equal(bg.isRedirectablePath("/i/bookmarks"), false);
    assert.equal(bg.isRedirectablePath("/messages"), false);
});

test("isHardFailure covers instance-side failures only", () => {
    for (const code of [401, 403, 429, 500, 503]) {
        assert.equal(bg.isHardFailure(code), true, `expected ${code} to be a hard failure`);
    }
    for (const code of [200, 301, 302, 404]) {
        assert.equal(bg.isHardFailure(code), false, `expected ${code} not to be a hard failure`);
    }
});

test("parseStatus keeps only permitted hosts, rejects junk", () => {
    const parsed = bg.parseStatus({
        hosts: [
            { domain: "nitter.kareem.one", healthy: true, points: 68, ping_avg: 700 },
            { domain: "nitter.click", healthy: false, points: 40, ping_avg: 1200, is_bad_host: true },
            { domain: "not.permitted.example", healthy: true, points: 99 }
        ]
    });
    assert.deepEqual(Object.keys(parsed).sort(), ["nitter.click", "nitter.kareem.one"]);
    assert.equal(parsed["nitter.kareem.one"].healthy, true);
    assert.equal(parsed["nitter.kareem.one"].points, 68);
    assert.equal(parsed["nitter.click"].isBadHost, true);

    assert.equal(bg.parseStatus({}), null);
    assert.equal(bg.parseStatus({ hosts: [] }), null);
    assert.equal(bg.parseStatus({ hosts: [{ domain: "not.permitted.example", healthy: true }] }), null);
});

test("sameAttempt matches on origin plus request id when known", () => {
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a", requestId: "5" }, "https://a", "5"), true);
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a", requestId: "5" }, "https://a", "6"), false);
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a" }, "https://a", "6"), true); // id not captured yet
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a", requestId: "5" }, "https://b", "5"), false);
    assert.equal(bg.sameAttempt(null, "https://a", "5"), false);
});

test("PERMITTED_ORIGINS is exactly the manifest's nine instance origins", () => {
    const origins = [...bg.PERMITTED_ORIGINS].sort();
    assert.equal(origins.length, 9);
    assert.ok(!origins.includes("https://status.d420.de"));
    for (const seed of bg.SEED_INSTANCES) {
        assert.ok(bg.PERMITTED_ORIGINS.has(seed), `${seed} must be permitted`);
    }
});

test("candidateOrigins is the seed list until fresh status data adds to it", () => {
    const sorted = (x) => Array.from(x).sort();
    assert.deepEqual(sorted(bg.candidateOrigins()), sorted(bg.SEED_INSTANCES));

    bg.setStatus({ "nitter.xitter.cc": { healthy: true } }, Date.now());
    assert.ok(Array.from(bg.candidateOrigins()).includes("https://nitter.xitter.cc"));

    // Stale data (older than STATUS_STALE_MS = 6h) is ignored.
    bg.setStatus({ "nitter.xitter.cc": { healthy: true } }, Date.now() - 7 * 60 * 60 * 1000);
    assert.ok(!Array.from(bg.candidateOrigins()).includes("https://nitter.xitter.cc"));

    bg.setStatus(null, 0);
});

test("recordLocal keeps BROKEN entries and drops cleared ones", () => {
    bg.recordLocal("https://nitter.kareem.one", "BROKEN");
    assert.ok("https://nitter.kareem.one" in bg.getLocalHealth());

    bg.recordLocal("https://nitter.kareem.one", "OK");
    assert.ok(!("https://nitter.kareem.one" in bg.getLocalHealth()));
});
