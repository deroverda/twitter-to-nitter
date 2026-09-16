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
    "originOf", "isRedirectablePath", "isHardFailure", "isDefinitiveNetworkFailure",
    "parseStatus", "sameAttempt", "candidateOrigins", "freshStatusHosts", "recordLocal",
    "PERMITTED_ORIGINS", "PERMITTED_DOMAINS", "SEED_INSTANCES", "refreshStatus",
    "noteRedirect", "breakerOpen", "terminalFailurePage"
];

function load(manifestOverride, fetchOverride) {
    const noop = () => {};
    const listener = { addListener: noop, removeListener: noop, hasListener: () => false };

    // background.js registers two separate onBeforeRequest listeners on the
    // same event; capture both in registration order so tests can drive the
    // second one (the permitted-instance "follow" listener) directly.
    const beforeRequestListeners = [];
    const trackingListener = {
        addListener: (fn) => beforeRequestListeners.push(fn),
        removeListener: noop,
        hasListener: () => false
    };

    const ctx = {
        console: { log: noop, warn: noop, error: noop },
        setTimeout: () => 0,
        clearTimeout: noop,
        setInterval: () => 0,
        clearInterval: noop,
        URL,
        AbortController: class { constructor() { this.signal = {}; } abort() {} },
        fetch: fetchOverride || (() => Promise.reject(new Error("no network in test"))),
        browser: {
            runtime: { getManifest: () => manifestOverride || manifest },
            webRequest: {
                onBeforeRequest: trackingListener,
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
        getLocalHealth: () => localHealth,
        getActiveRedirects: () => activeRedirects,
        getRanked: () => ranked,
        recomputeRanking: () => recomputeRanking() };`;
    vm.runInContext(SRC + epilogue, ctx);
    return { ...ctx.__t, followListener: beforeRequestListeners[1] };
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
    assert.equal(bg.isRedirectablePath("/i/lists/123"), true);
    assert.equal(bg.isRedirectablePath("/i/lists/123/members"), true);
    assert.equal(bg.isRedirectablePath("/home"), false);
    assert.equal(bg.isRedirectablePath("/settings/profile"), false);
    assert.equal(bg.isRedirectablePath("/i/bookmarks"), false);
    assert.equal(bg.isRedirectablePath("/i/spaces/abc"), false);
    assert.equal(bg.isRedirectablePath("/messages"), false);
});

test("isHardFailure covers instance-side failures only", () => {
    for (const code of [401, 403, 408, 429, 500, 503]) {
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

test("parseStatus normalizes domain casing and a trailing dot", () => {
    const parsed = bg.parseStatus({
        hosts: [{ domain: "Nitter.Kareem.One.", healthy: true, points: 50 }]
    });
    assert.deepEqual(Object.keys(parsed), ["nitter.kareem.one"]);
    assert.equal(parsed["nitter.kareem.one"].healthy, true);
});

test("a seed instance without a matching host permission is excluded from ranking", () => {
    const strippedManifest = JSON.parse(JSON.stringify(manifest));
    strippedManifest.permissions = strippedManifest.permissions.filter(
        p => p !== "https://shitter.thepixora.com/*"
    );
    const bg2 = load(strippedManifest);

    assert.ok(!bg2.PERMITTED_ORIGINS.has("https://shitter.thepixora.com"));
    assert.ok(bg2.SEED_INSTANCES.includes("https://shitter.thepixora.com"), "the raw seed list itself is unchanged");
    assert.ok(
        !Array.from(bg2.candidateOrigins()).includes("https://shitter.thepixora.com"),
        "an unpermitted seed must not be redirected to -- its outcome events would be unobservable"
    );
});

test("refreshStatus recomputes ranking even when its own fetch fails, dropping stale-promoted instances", async () => {
    const bg2 = load();

    bg2.setStatus({ "nitter.xitter.cc": { healthy: true, points: 99, ping: 10 } }, Date.now());
    bg2.recomputeRanking();
    assert.ok(bg2.getRanked().includes("https://nitter.xitter.cc"), "promoted instance should be ranked while status is fresh");

    // Age the same data past STATUS_STALE_MS (6h) without calling recomputeRanking
    // directly -- only refreshStatus() itself should be relied on to notice.
    bg2.setStatus({ "nitter.xitter.cc": { healthy: true, points: 99, ping: 10 } }, Date.now() - 7 * 60 * 60 * 1000);
    await bg2.refreshStatus();

    assert.ok(
        !bg2.getRanked().includes("https://nitter.xitter.cc"),
        "a stale-promoted instance must drop out of ranking once refreshStatus runs, even if its own fetch fails"
    );
});

test("sameAttempt matches on origin plus request id when known", () => {
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a", requestId: "5" }, "https://a", "5"), true);
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a", requestId: "5" }, "https://a", "6"), false);
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a" }, "https://a", "6"), true); // id not captured yet
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a", requestId: "5" }, "https://b", "5"), false);
    assert.equal(bg.sameAttempt(null, "https://a", "5"), false);
});

test("PERMITTED_ORIGINS is exactly the manifest's eight instance origins", () => {
    const origins = [...bg.PERMITTED_ORIGINS].sort();
    assert.equal(origins.length, 8);
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

test("a link clicked from inside a Nitter instance is still tracked for fallback", () => {
    const tabId = 4242;
    assert.ok(!bg.getActiveRedirects().has(tabId));

    bg.followListener({
        type: "main_frame",
        tabId: tabId,
        requestId: "req-1",
        url: "https://nitter.kareem.one/jack/status/1",
        originUrl: "https://nitter.kareem.one/jack"
    });

    const record = bg.getActiveRedirects().get(tabId);
    assert.ok(record, "an internal Nitter link click must still be tracked, so a failure it leads to can fall back");
    assert.equal(record.tried[0], "https://nitter.kareem.one");
});

test("isDefinitiveNetworkFailure only matches genuine network-level errors", () => {
    for (const error of ["NS_ERROR_NET_TIMEOUT", "NS_ERROR_NET_RESET", "NS_ERROR_CONNECTION_REFUSED", "NS_ERROR_UNKNOWN_HOST"]) {
        assert.equal(bg.isDefinitiveNetworkFailure(error), true, `expected ${error} to be a definitive network failure`);
    }
    for (const error of ["NS_ERROR_PROXY_CONNECTION_REFUSED", "NS_ERROR_UNKNOWN_PROXY_HOST", "NS_ERROR_TRACKING_URI", "NS_BINDING_ABORTED", undefined, ""]) {
        assert.equal(bg.isDefinitiveNetworkFailure(error), false, `expected ${error} not to be a definitive network failure`);
    }
});

test("loop breaker tolerates rapid legitimate clicks and self-clears quickly", () => {
    const tabId = 9191;
    assert.equal(bg.breakerOpen(tabId), false);

    for (let i = 0; i < 6; i++) {
        bg.noteRedirect(tabId);
    }
    assert.equal(bg.breakerOpen(tabId), false, "6 X interceptions in the window must not trip the breaker");

    bg.noteRedirect(tabId);
    assert.equal(bg.breakerOpen(tabId), true, "a 7th interception in the same window should trip it");
});

test("refreshStatus rejects an oversized response before parsing it", async () => {
    const oversizedFetch = async () => ({
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(2 * 1024 * 1024) : null) },
        json: async () => ({ hosts: [{ domain: "nitter.xitter.cc", healthy: true, points: 99 }] })
    });
    const bg2 = load(undefined, oversizedFetch);

    await bg2.refreshStatus();

    assert.ok(
        !Array.from(bg2.candidateOrigins()).includes("https://nitter.xitter.cc"),
        "an oversized response must be rejected before its data is parsed and applied"
    );
});

test("terminalFailurePage builds a self-contained data: URL with an escaped retry link", () => {
    const url = bg.terminalFailurePage("/jack/status/1?ref=<script>");

    assert.ok(url.startsWith("data:text/html;charset=utf-8,"));

    const html = decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));
    assert.ok(html.includes("https://x.com/jack/status/1?ref=&lt;script&gt;"));
    assert.ok(!html.includes("<script>"), "path must be HTML-escaped before embedding");
});

test("recordLocal keeps BROKEN entries and drops cleared ones", () => {
    bg.recordLocal("https://nitter.kareem.one", "BROKEN");
    assert.ok("https://nitter.kareem.one" in bg.getLocalHealth());

    bg.recordLocal("https://nitter.kareem.one", "OK");
    assert.ok(!("https://nitter.kareem.one" in bg.getLocalHealth()));
});
