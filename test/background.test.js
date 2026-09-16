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
    "noteRedirect", "breakerOpen", "terminalFailurePage", "isHTMLResponse",
    "pickInitialInstance", "templateMismatchTripped", "NAV_TIMEOUT_MS",
    "NAV_STREAM_TIMEOUT_MS", "MAX_FALLBACK_MS", "readBoundedJSON", "STATUS_MAX_BODY_BYTES"
];

// A controllable fake clock and timer queue, so watchdog/switchInstance tests
// can assert on what fires after N virtual milliseconds instead of sleeping
// in real time. setTimeout here only records {fn, due}; nothing runs until a
// test calls advance().
function load(manifestOverride, fetchOverride, randomOverride, options = {}) {
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

    // onCompleted/onErrorOccurred/onResponseStarted each get exactly one
    // real listener; capture it in a box so tests can invoke it directly.
    function captureListener(box) {
        return { addListener: (fn) => { box.fn = fn; }, removeListener: noop, hasListener: () => false };
    }
    const onCompletedBox = {};
    const onErrorBox = {};
    const onResponseStartedBox = {};
    const onMessageBox = {};

    let clockValue = typeof options.now === "number" ? options.now : Date.now();
    let timerId = 1;
    const timers = new Map();

    async function advance(ms) {
        clockValue += ms;

        const due = Array.from(timers.entries())
            .filter(([, t]) => t.due <= clockValue)
            .sort((a, b) => a[1].due - b[1].due);

        for (const [id] of due) {
            timers.delete(id);
        }

        for (const [, t] of due) {
            await t.fn();
        }
    }

    const tabState = { url: undefined, status: "loading" };
    const tabsUpdateCalls = [];
    const storageData = { ...(options.initialStorage || {}) };

    const ctx = {
        console: { log: noop, warn: noop, error: noop },
        setTimeout: (fn, ms = 0) => {
            const id = timerId++;
            timers.set(id, { fn, due: clockValue + ms });
            return id;
        },
        clearTimeout: (id) => { timers.delete(id); },
        setInterval: () => 0,
        clearInterval: noop,
        URL,
        TextDecoder,
        Date: { now: () => clockValue },
        Math: randomOverride ? { random: randomOverride, floor: Math.floor } : Math,
        AbortController: class { constructor() { this.signal = {}; } abort() {} },
        fetch: fetchOverride || (() => Promise.reject(new Error("no network in test"))),
        browser: {
            runtime: {
                getManifest: () => manifestOverride || manifest,
                getURL: (path) => `moz-extension://test-id/${path}`,
                onMessage: captureListener(onMessageBox)
            },
            webRequest: {
                onBeforeRequest: trackingListener,
                onCompleted: captureListener(onCompletedBox),
                onErrorOccurred: captureListener(onErrorBox),
                onResponseStarted: captureListener(onResponseStartedBox)
            },
            tabs: {
                onRemoved: listener,
                get: options.tabsGet || (async () => ({ url: tabState.url, status: tabState.status })),
                query: async () => [{ url: tabState.url, status: tabState.status }],
                update: async (tabId, opts) => {
                    tabsUpdateCalls.push({ tabId, ...opts });
                    return {};
                },
                executeScript: options.executeScript || (async () => [false])
            },
            storage: {
                local: {
                    get: async (keys) => {
                        if (!keys) {
                            return { ...storageData };
                        }

                        const keyList = Array.isArray(keys) ? keys : [keys];
                        const result = {};

                        for (const key of keyList) {
                            if (key in storageData) {
                                result[key] = storageData[key];
                            }
                        }

                        return result;
                    },
                    set: async (obj) => { Object.assign(storageData, obj); },
                    remove: async (keys) => {
                        for (const key of (Array.isArray(keys) ? keys : [keys])) {
                            delete storageData[key];
                        }
                    }
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
        getRankedTopTier: () => rankedTopTier,
        getPreferredInstance: () => preferredInstance,
        recomputeRanking: () => recomputeRanking() };`;
    vm.runInContext(SRC + epilogue, ctx);
    return {
        ...ctx.__t,
        followListener: beforeRequestListeners[1],
        interceptListener: beforeRequestListeners[0],
        onCompleted: (details) => onCompletedBox.fn(details),
        onErrorOccurred: (details) => onErrorBox.fn(details),
        onResponseStarted: (details) => onResponseStartedBox.fn(details),
        sendMessage: (message) => onMessageBox.fn(message),
        advance,
        setTab: (url, status) => { tabState.url = url; tabState.status = status || "loading"; },
        getTabUpdateCalls: () => tabsUpdateCalls,
        getStorage: () => ({ ...storageData }),
        pendingTimerCount: () => timers.size
    };
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

test("sameAttempt requires an exact request id match, no undefined wildcard", () => {
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a", requestId: "5" }, "https://a", "5"), true);
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a", requestId: "5" }, "https://a", "6"), false);
    // A record whose requestId hasn't been captured yet must not match any
    // request as a wildcard: by the time an outcome event can fire, the
    // onBeforeRequest listener for that request has already stamped
    // record.requestId, so an undefined requestId here means the event
    // belongs to no tracked request and must be rejected, not accepted.
    assert.equal(bg.sameAttempt({ currentOrigin: "https://a" }, "https://a", "6"), false);
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

test("record.path is kept in sync with a followed navigation, not left at its original value", () => {
    const tabId = 5252;

    bg.followListener({
        type: "main_frame",
        tabId: tabId,
        requestId: "req-a",
        url: "https://nitter.kareem.one/jack"
    });
    assert.equal(bg.getActiveRedirects().get(tabId).path, "/jack");

    bg.followListener({
        type: "main_frame",
        tabId: tabId,
        requestId: "req-b",
        url: "https://nitter.kareem.one/jack/status/123"
    });
    assert.equal(
        bg.getActiveRedirects().get(tabId).path,
        "/jack/status/123",
        "a later navigation on the same tracked attempt must update record.path, so a subsequent timeout falls back to the page the user is actually on"
    );
});

test("isHTMLResponse only judges text/html, defaults to true when the header is missing or malformed", () => {
    const htmlHeaders = [{ name: "Content-Type", value: "text/html; charset=utf-8" }];
    const imageHeaders = [{ name: "content-type", value: "image/jpeg" }];

    assert.equal(bg.isHTMLResponse(htmlHeaders), true);
    assert.equal(bg.isHTMLResponse(imageHeaders), false, "a directly-opened image must not be judged by check-page.js");
    assert.equal(bg.isHTMLResponse([]), true, "no content-type header present: default to checking");
    assert.equal(bg.isHTMLResponse(undefined), true, "responseHeaders unavailable: default to checking");
    assert.equal(bg.isHTMLResponse([{ name: "Content-Type" }]), true, "malformed header value: default to checking");
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

test("terminalFailurePage returns a packaged extension page, not a data: URL", () => {
    const url = bg.terminalFailurePage("/jack/status/1?ref=<script>");

    assert.ok(
        url.startsWith("moz-extension://test-id/terminal-failure.html?path="),
        "must be an extension-page URL -- Firefox's tabs.update() rejects data: URLs outright"
    );
    assert.ok(
        url.includes(encodeURIComponent("/jack/status/1?ref=<script>")),
        "original path must survive URL encoding"
    );
});

test("pickInitialInstance spreads picks across the fully-healthy tier instead of always the top-ranked instance", () => {
    const picks = [0, 0.99];
    let i = 0;
    const bg2 = load(undefined, undefined, () => picks[i++ % picks.length]);

    const topTier = bg2.getRankedTopTier();
    assert.ok(topTier.length > 1, "seed instances with no local/remote failure signal should all be in the top tier");

    assert.equal(bg2.pickInitialInstance(), topTier[0]);
    assert.equal(bg2.pickInitialInstance(), topTier[topTier.length - 1]);
});

test("pickInitialInstance falls back to the strict top pick once every candidate is locally broken", () => {
    const bg2 = load();

    for (const seed of bg2.SEED_INSTANCES) {
        bg2.recordLocal(seed, "BROKEN");
    }

    assert.equal(bg2.getRankedTopTier().length, 0, "every candidate is locally broken, so the top tier is empty");
    assert.equal(bg2.pickInitialInstance(), bg2.getRanked()[0]);
});

test("recordLocal keeps BROKEN entries and drops cleared ones", () => {
    bg.recordLocal("https://nitter.kareem.one", "BROKEN");
    assert.ok("https://nitter.kareem.one" in bg.getLocalHealth());

    bg.recordLocal("https://nitter.kareem.one", "OK");
    assert.ok(!("https://nitter.kareem.one" in bg.getLocalHealth()));
});

// ============================================================
// Watchdog / switchInstance state machine, driven by the fake clock
// ============================================================

test("a pure timeout with no response at all falls back once NAV_TIMEOUT_MS elapses", async () => {
    const bg2 = load(undefined, undefined, undefined, { now: 0 });
    const tabId = 6000;

    bg2.interceptListener({ type: "main_frame", tabId, url: "https://x.com/jack" });
    assert.equal(bg2.getTabUpdateCalls().length, 0, "must not fall back before the watchdog fires");

    await bg2.advance(bg2.NAV_TIMEOUT_MS);

    assert.equal(bg2.getTabUpdateCalls().length, 1, "the dead-timeout must fall back once it elapses");
});

test("onResponseStarted re-arms the watchdog at the longer streaming timeout instead of treating a slow response as dead", async () => {
    const bg2 = load(undefined, undefined, undefined, { now: 0 });
    const tabId = 6001;

    const redirect = bg2.interceptListener({ type: "main_frame", tabId, url: "https://x.com/jack" });
    const origin = new URL(redirect.redirectUrl).origin;

    await bg2.onResponseStarted({ type: "main_frame", tabId, url: origin + "/jack", requestId: undefined });

    await bg2.advance(bg2.NAV_TIMEOUT_MS);
    assert.equal(
        bg2.getTabUpdateCalls().length,
        0,
        "the short dead-timeout must not fire once headers have started arriving"
    );

    await bg2.advance(bg2.NAV_STREAM_TIMEOUT_MS - bg2.NAV_TIMEOUT_MS);
    assert.equal(
        bg2.getTabUpdateCalls().length,
        1,
        "the longer streaming timeout should still fall back if the response never finishes"
    );
});

test("switchInstance bounds total fallback time by elapsed wall-clock time, not just instance count", async () => {
    const bg2 = load(undefined, undefined, undefined, { now: 0 });
    const tabId = 6002;

    bg2.interceptListener({ type: "main_frame", tabId, url: "https://x.com/jack" });

    let iterations = 0;

    while (bg2.getActiveRedirects().has(tabId) && iterations < bg2.SEED_INSTANCES.length + 2) {
        await bg2.advance(bg2.NAV_TIMEOUT_MS);
        iterations++;
    }

    assert.ok(
        !bg2.getActiveRedirects().has(tabId),
        "the attempt must end once MAX_FALLBACK_MS is exceeded, even with untried candidates left"
    );
    assert.ok(
        iterations < bg2.SEED_INSTANCES.length,
        "it must stop well before exhausting every seed instance by count"
    );

    const lastUpdate = bg2.getTabUpdateCalls().at(-1);
    assert.ok(
        lastUpdate.url.includes("terminal-failure.html"),
        "must land on the terminal failure page, not just stop silently"
    );
});

test("an 'unknown' page-template verdict falls back without demoting the instance, and trips the tripwire after enough distinct instances", async () => {
    const bg2 = load(undefined, undefined, undefined, {
        now: 0,
        executeScript: async () => ["unknown"]
    });

    const origins = bg2.SEED_INSTANCES.slice(0, 4);
    assert.equal(bg2.templateMismatchTripped(), false);

    for (let i = 0; i < origins.length; i++) {
        const tabId = 8000 + i;
        const origin = origins[i];

        bg2.getActiveRedirects().set(tabId, {
            path: "/jack",
            tried: [origin],
            timer: null,
            switching: false,
            startedAt: 0,
            currentOrigin: origin
        });
        bg2.setTab(origin + "/jack", "complete");

        await bg2.onCompleted({
            type: "main_frame",
            tabId,
            url: origin + "/jack",
            requestId: undefined,
            statusCode: 200,
            responseHeaders: undefined
        });

        assert.equal(
            bg2.getLocalHealth()[origin],
            undefined,
            "an 'unknown' verdict must never demote the instance fleet-wide"
        );
    }

    assert.equal(
        bg2.templateMismatchTripped(),
        true,
        `${origins.length} distinct instances judged unknown within the window should trip the diagnostic tripwire`
    );
});

test("a confirmed 'fail' verdict still demotes the instance fleet-wide", async () => {
    const bg2 = load(undefined, undefined, undefined, {
        now: 0,
        executeScript: async () => ["fail"]
    });
    const tabId = 8100;
    const origin = bg2.SEED_INSTANCES[0];

    bg2.getActiveRedirects().set(tabId, {
        path: "/jack",
        tried: [origin],
        timer: null,
        switching: false,
        startedAt: 0,
        currentOrigin: origin
    });
    bg2.setTab(origin + "/jack", "complete");

    await bg2.onCompleted({
        type: "main_frame",
        tabId,
        url: origin + "/jack",
        requestId: undefined,
        statusCode: 200,
        responseHeaders: undefined
    });

    assert.equal(bg2.getLocalHealth()[origin].state, "BROKEN");
});

// ============================================================
// Attempt-identity races (external audit findings, 2026-09-16)
// ============================================================

// A tracked attempt already in flight for `origin`, as if switchInstance had
// just redirected the tab there and armed a watchdog for it.
function activeRecord(origin) {
    return { path: "/jack", tried: [origin], timer: null, switching: false, startedAt: 0, currentOrigin: origin, attemptId: 1 };
}

test("a stale watchdog cannot hijack a newer same-origin attempt (self-redirect race)", async () => {
    let releaseTabsGet;
    const gate = new Promise((resolve) => { releaseTabsGet = resolve; });
    let tabsGetCalls = 0;

    const bg2 = load(undefined, undefined, undefined, {
        now: 0,
        tabsGet: async () => {
            tabsGetCalls++;
            await gate;
            return { url: undefined, status: "loading" };
        }
    });
    const tabId = 9000;

    const redirect = bg2.interceptListener({ type: "main_frame", tabId, url: "https://x.com/jack" });
    const origin = new URL(redirect.redirectUrl).origin;

    bg2.followListener({ type: "main_frame", tabId, url: origin + "/jack", requestId: "req-1" });

    // Fire the watchdog. Its callback starts and blocks inside
    // `await browser.tabs.get(tabId)` (held open by `gate` above).
    const watchdogFire = bg2.advance(bg2.NAV_TIMEOUT_MS);
    assert.equal(tabsGetCalls, 1, "the watchdog must have started its liveness check");

    // Before that await resolves, a same-origin self-redirect supersedes the
    // attempt (e.g. /i/web/status/<id> -> /i/status/<id>): the "follow"
    // listener reuses the same record and origin, with a new request id.
    bg2.followListener({ type: "main_frame", tabId, url: origin + "/i/status/1", requestId: "req-2" });

    // Now let the stale watchdog's liveness check resolve and finish.
    releaseTabsGet();
    await watchdogFire;

    assert.equal(
        bg2.getTabUpdateCalls().length,
        0,
        "the stale watchdog must not redirect the tab away from the newer, still-loading attempt"
    );
});

test("armWatchdog caps its re-arm delay by the remaining MAX_FALLBACK_MS budget", async () => {
    // Start the clock 44s into the attempt (1s before the 45s
    // MAX_FALLBACK_MS deadline) so response headers can "arrive now" without
    // an earlier, unrelated watchdog tick ever having a chance to fire first.
    const bg2 = load(undefined, undefined, undefined, { now: bg.MAX_FALLBACK_MS - 1000 });
    const tabId = 9100;
    const origin = bg2.SEED_INSTANCES[0];

    bg2.getActiveRedirects().set(tabId, activeRecord(origin));

    // A naive re-arm would wait the full 20s stream timeout (~64s total
    // elapsed); the capped watchdog must fire within the ~1s actually left.
    await bg2.onResponseStarted({ type: "main_frame", tabId, url: origin + "/jack", requestId: undefined });

    await bg2.advance(999);
    assert.equal(bg2.getTabUpdateCalls().length, 0, "must not fall back before the capped delay elapses");

    await bg2.advance(2);
    assert.equal(
        bg2.getTabUpdateCalls().length,
        1,
        "must fall back once the absolute MAX_FALLBACK_MS deadline passes, not wait out the full stream timeout"
    );
});

test("a hard HTTP failure falls back even when the tab's URL hasn't committed yet", async () => {
    const bg2 = load(undefined, undefined, undefined, { now: 0 });
    const tabId = 9200;
    const origin = bg2.SEED_INSTANCES[0];

    bg2.getActiveRedirects().set(tabId, activeRecord(origin));
    // onCompleted (network finished) firing does not mean the tab's URL has
    // been updated to reflect it yet -- those are two distinct moments, not
    // one. Leave it unreadable to simulate the gap between them.
    bg2.setTab(undefined, "loading");

    await bg2.onCompleted({
        type: "main_frame", tabId, url: origin + "/jack", requestId: undefined,
        statusCode: 503, responseHeaders: undefined
    });

    assert.equal(bg2.getLocalHealth()[origin].state, "BROKEN");
    assert.equal(
        bg2.getTabUpdateCalls().length,
        1,
        "must still fall back or show the terminal page instead of silently abandoning the attempt"
    );
});

test("a 403 with a Cloudflare challenge header is not treated as an immediate hard failure", async () => {
    const bg2 = load(undefined, undefined, undefined, {
        now: 0,
        executeScript: async () => [false] // check-page.js recognizes the challenge as transient
    });
    const tabId = 9300;
    const origin = bg2.SEED_INSTANCES[0];

    bg2.getActiveRedirects().set(tabId, activeRecord(origin));
    bg2.setTab(origin + "/jack", "complete");

    await bg2.onCompleted({
        type: "main_frame", tabId, url: origin + "/jack", requestId: undefined,
        statusCode: 403, responseHeaders: [{ name: "cf-mitigated", value: "challenge" }]
    });

    assert.equal(
        bg2.getLocalHealth()[origin],
        undefined,
        "a Cloudflare challenge response must not demote the instance the way a real hard failure would"
    );
});

test("a plain 403 with no Cloudflare challenge header is still a hard failure", async () => {
    const bg2 = load(undefined, undefined, undefined, { now: 0 });
    const tabId = 9301;
    const origin = bg2.SEED_INSTANCES[0];

    bg2.getActiveRedirects().set(tabId, activeRecord(origin));

    await bg2.onCompleted({
        type: "main_frame", tabId, url: origin + "/jack", requestId: undefined,
        statusCode: 403, responseHeaders: undefined
    });

    assert.equal(bg2.getLocalHealth()[origin].state, "BROKEN");
});

// ============================================================
// readBoundedJSON -- status response size guard
// ============================================================

test("readBoundedJSON enforces the size guard even without a Content-Length header (chunked bypass)", async () => {
    const oversized = new Uint8Array(bg.STATUS_MAX_BODY_BYTES + 1);
    let delivered = false;
    const reader = {
        read: async () => {
            if (delivered) {
                return { done: true, value: undefined };
            }
            delivered = true;
            return { done: false, value: oversized };
        },
        cancel: async () => {}
    };

    await assert.rejects(() => bg.readBoundedJSON({ body: { getReader: () => reader } }, bg.STATUS_MAX_BODY_BYTES));
});

test("readBoundedJSON parses a normal streamed body under the size guard", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ hosts: [] }));
    let delivered = false;
    const reader = {
        read: async () => {
            if (delivered) {
                return { done: true, value: undefined };
            }
            delivered = true;
            return { done: false, value: bytes };
        },
        cancel: async () => {}
    };

    const parsed = await bg.readBoundedJSON({ body: { getReader: () => reader } }, bg.STATUS_MAX_BODY_BYTES);
    // JSON.parse ran inside the vm context, so the result is a cross-realm
    // object; assert.deepEqual's identity checks on it are unreliable
    // (see Node's "same structure but not reference-equal" special case).
    assert.equal(JSON.stringify(parsed), JSON.stringify({ hosts: [] }));
});

// ============================================================
// Preferred instance -- popup messaging and pickInitialInstance bias
// ============================================================

function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

test("pickInitialInstance prefers a set instance while it's healthy", async () => {
    const bg2 = load(undefined, undefined, () => 0.99); // would otherwise pick the last top-tier entry
    await flushMicrotasks(); // let init()'s own storage read settle before this test's writes
    const preferred = bg2.SEED_INSTANCES[2];

    const setResult = await bg2.sendMessage({ type: "setPreferred", origin: preferred });
    assert.equal(setResult.preferredInstance, preferred);
    assert.equal(bg2.getPreferredInstance(), preferred);

    assert.equal(bg2.pickInitialInstance(), preferred);
});

test("pickInitialInstance falls through to the normal spread once the preferred instance is broken", async () => {
    const bg2 = load();
    await flushMicrotasks();
    const preferred = bg2.SEED_INSTANCES[0];

    await bg2.sendMessage({ type: "setPreferred", origin: preferred });
    bg2.recordLocal(preferred, "BROKEN");

    assert.notEqual(
        bg2.pickInitialInstance(),
        preferred,
        "a down preferred instance must never be forced -- normal fallback selection takes over"
    );
    assert.equal(
        bg2.getPreferredInstance(),
        preferred,
        "the preference itself must stay set so it resumes once the instance recovers"
    );
});

test("setPreferred rejects an origin outside the permitted set", async () => {
    const bg2 = load();
    await flushMicrotasks();

    const result = await bg2.sendMessage({ type: "setPreferred", origin: "https://evil.example" });

    assert.equal(result, undefined);
    assert.equal(bg2.getPreferredInstance(), null);
});

test("clearPreferred resets state and removes the stored key", async () => {
    const bg2 = load();
    await flushMicrotasks();
    const preferred = bg2.SEED_INSTANCES[0];

    await bg2.sendMessage({ type: "setPreferred", origin: preferred });
    assert.ok("preferredInstance" in bg2.getStorage());

    const result = await bg2.sendMessage({ type: "clearPreferred" });
    assert.equal(result.preferredInstance, null);
    assert.equal(bg2.getPreferredInstance(), null);
    assert.ok(!("preferredInstance" in bg2.getStorage()));
});

test("getPopupState reports the active tab's origin only when it's a permitted Nitter instance", async () => {
    const bg2 = load();
    await flushMicrotasks();
    const preferred = bg2.SEED_INSTANCES[1];
    await bg2.sendMessage({ type: "setPreferred", origin: preferred });

    bg2.setTab(preferred + "/jack", "complete");
    let state = await bg2.sendMessage({ type: "getPopupState" });
    assert.equal(state.currentOrigin, preferred);
    assert.equal(state.preferredInstance, preferred);

    bg2.setTab("https://example.com/", "complete");
    state = await bg2.sendMessage({ type: "getPopupState" });
    assert.equal(state.currentOrigin, null, "a non-Nitter tab must not be reported as the current origin");
});

test("init() loads a valid stored preference, but discards one that's no longer a permitted origin", async () => {
    const validBg = load(undefined, undefined, undefined, {
        initialStorage: { preferredInstance: "https://nitter.kareem.one" }
    });
    await flushMicrotasks();
    assert.equal(validBg.getPreferredInstance(), "https://nitter.kareem.one");

    const staleBg = load(undefined, undefined, undefined, {
        initialStorage: { preferredInstance: "https://no-longer-permitted.example" }
    });
    await flushMicrotasks();
    assert.equal(
        staleBg.getPreferredInstance(),
        null,
        "a stored preference for an origin that's no longer permitted must be discarded, not applied"
    );
});

test("readBoundedJSON falls back to response.json() when no streaming body reader is available", async () => {
    const parsed = await bg.readBoundedJSON(
        { json: async () => ({ hosts: [] }) },
        bg.STATUS_MAX_BODY_BYTES
    );
    assert.deepEqual(parsed, { hosts: [] });
});
