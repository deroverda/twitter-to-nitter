// Twitter/X to Nitter
//
// Architecture
// ------------
// X/Twitter navigations are intercepted with a blocking webRequest listener and
// redirected before the request leaves the browser, so X never receives the
// navigation and never becomes the visible destination. The redirect decision is
// synchronous and always made from data already in memory.
//
// The instance list is driven live by the Nitter Instance Health service at
// https://status.d420.de/ (thanks to its operator), polled on a timer and cached
// locally. Its API is explicitly intended for redirector services of this kind.
// Within the set of origins the manifest grants host access to, the service
// decides which instances are active and how they rank; it is never on the
// critical navigation path, and no browsing data is sent to it. A shipped seed
// list is the cold-start and offline fallback.
//
// Local instance health comes from the outcome of the user's own navigations.
// The extension generates no synthetic probe traffic to public Nitter instances.

"use strict";


// ============================================================
// Configuration
// ============================================================

// Cold-start and offline fallback list, and the ranking floor. Used verbatim
// until the status service responds, and whenever it is unreachable or stale.
// The live active list (see candidateOrigins) is this plus any status-service
// instance currently reported healthy that the manifest also permits.
//
// Upstream Nitter resumed development in September 2026 after legal advice
// (github.com/zedeus/nitter, "Nitter lives"), following X Corp's 2026-08-24
// cease-and-desist. lightbrd.com stays out regardless of uptime: per
// github.com/zedeus/nitter/issues/1209 it doesn't proxy images/video/GIFs
// (they connect directly to Twitter's CDN) and loads Microsoft Clarity
// analytics -- a privacy leak this extension exists to avoid.
const SEED_INSTANCES = [
    "https://nitter.kareem.one",
    "https://nitter.jaydenha.uk",
    "https://nitter.click",
    "https://nitter.meowing.monster",
    "https://nitter.netbub.com",
    "https://nitter.miningtcup.me",
    "https://shitter.thepixora.com",
    "https://xcancel.com"
];

// Every https origin the manifest grants host access to, minus the status
// service itself. The status service can promote any of these into the active
// list once it reports the instance healthy, and drop it when it doesn't; it
// can never introduce an origin the manifest has not already permitted,
// because a blocking redirect requires a static host permission for its target.
const PERMITTED_ORIGINS = new Set(
    (browser.runtime.getManifest().permissions || [])
        .filter(perm => /^https:\/\//.test(perm))
        .map(perm => {
            try {
                return new URL(perm.replace(/\/\*$/, "")).origin;
            } catch {
                return null;
            }
        })
        .filter(origin => origin && origin !== "https://status.d420.de")
);

const PERMITTED_DOMAINS = new Set(
    Array.from(PERMITTED_ORIGINS, origin => new URL(origin).hostname)
);

const TWITTER_HOSTS = new Set([
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
    "x.com",
    "www.x.com",
    "mobile.x.com"
]);

const TWITTER_URL_PATTERNS = [
    "*://twitter.com/*",
    "*://www.twitter.com/*",
    "*://mobile.twitter.com/*",
    "*://x.com/*",
    "*://www.x.com/*",
    "*://mobile.x.com/*"
];

// Covers every instance the extension could ever redirect to, so the outcome
// listeners fire for status-service-added instances too, not just seed ones.
const NITTER_URL_PATTERNS = Array.from(PERMITTED_ORIGINS, origin => origin + "/*");

// X-only surfaces Nitter has no equivalent for.
const UNSUPPORTED_PREFIXES = [
    "/home",
    "/notifications",
    "/messages",
    "/settings",
    "/explore",
    "/compose",
    "/intent",
    "/share",
    "/login",
    "/logout",
    "/account",
    "/tos",
    "/privacy"
];

// Canonical status permalinks under /i/ that Nitter does serve. Nitter itself
// redirects /i/web/status/<id> to /i/status/<id>, so both are passed through.
const SUPPORTED_I_PATH = /^\/i\/(web\/)?status\/\d+/;

const STATUS_API = "https://status.d420.de/api/v1/instances";

// The service updates every 900s; polling faster than that gets rate limited.
const STATUS_REFRESH_MS = 15 * 60 * 1000;
const STATUS_RETRY_MS = 5 * 60 * 1000;
const STATUS_BACKOFF_MS = 60 * 60 * 1000;
const STATUS_STALE_MS = 6 * 60 * 60 * 1000;
const STATUS_FETCH_TIMEOUT_MS = 8000;

// How long a locally observed hard failure keeps an instance demoted.
const LOCAL_FAILURE_TTL_MS = 30 * 60 * 1000;

// If a redirected navigation neither completes nor errors within this window,
// treat the instance as hanging and move on. Firefox's own network timeout is
// far too long to leave the user staring at a blank tab.
const NAV_TIMEOUT_MS = 8000;

// Circuit breaker against pathological redirect loops.
const LOOP_WINDOW_MS = 10000;
const LOOP_MAX_REDIRECTS = 3;
const LOOP_SUPPRESS_MS = 30000;

const STATUS_KEY = "statusCache";
const HEALTH_KEY = "instanceHealth";
const LEGACY_KEYS = ["workingInstance"];



// ============================================================
// State
//
// Everything the redirect path reads lives in memory, so the decision is
// synchronous. The seed list order is the floor: it is available from the
// first line of this script, before any storage or network work completes.
// ============================================================

let statusHosts = null;
let statusFetchedAt = 0;
let statusBackoffUntil = 0;

let localHealth = {};

let ranked = SEED_INSTANCES.slice();


// ============================================================
// Ranking
//
// The candidate list is the seed list plus any status-service instance
// currently reported healthy that the manifest also permits. It is then
// ordered by:
//
// 1. instances not locally known-broken
// 2. healthy per the status service
// 3. higher points, then lower average response time
// 4. seed list order as a deterministic tiebreaker (seed instances first,
//    then status-service additions in the order the service returned them)
// ============================================================

function domainOf(origin) {
    return new URL(origin).hostname;
}

function statusFor(origin) {
    if (!statusHosts) {
        return null;
    }

    return statusHosts[domainOf(origin)] || null;
}

// Seed list, plus every status-service instance currently healthy and
// permitted by the manifest. Recomputed on each ranking pass, so the service
// adds and drops instances live within the manifest-permitted set.
function candidateOrigins() {
    const origins = new Set(SEED_INSTANCES);

    if (statusHosts) {
        for (const [domain, info] of Object.entries(statusHosts)) {
            if (info.healthy && PERMITTED_DOMAINS.has(domain)) {
                origins.add("https://" + domain);
            }
        }
    }

    return Array.from(origins);
}

function locallyBroken(origin, now) {
    const entry = localHealth[origin];

    return Boolean(
        entry &&
        entry.state === "BROKEN" &&
        (now - entry.at) < LOCAL_FAILURE_TTL_MS
    );
}

function recomputeRanking() {
    const now = Date.now();

    ranked = candidateOrigins()
        .map((origin, index) => {
            const info = statusFor(origin);

            return {
                origin: origin,
                broken: locallyBroken(origin, now) ? 1 : 0,
                unhealthy: info ? (info.healthy ? 0 : 1) : 0,
                unknown: info ? 0 : 1,
                badHost: info && info.isBadHost ? 1 : 0,
                points: info && typeof info.points === "number" ? info.points : -1,
                ping: info && typeof info.ping === "number" ? info.ping : Number.MAX_SAFE_INTEGER,
                index: index
            };
        })
        .sort((a, b) =>
            a.broken - b.broken ||
            a.unhealthy - b.unhealthy ||
            a.badHost - b.badHost ||
            a.unknown - b.unknown ||
            b.points - a.points ||
            a.ping - b.ping ||
            a.index - b.index
        )
        .map(entry => entry.origin);
}

// Least-bad selection: the ranking always includes the full seed list, so there
// is no path where the absence of a healthy instance lets X through.
function pickInstance(exclude) {
    for (const origin of ranked) {
        if (!exclude || !exclude.includes(origin)) {
            return origin;
        }
    }

    return null;
}


// ============================================================
// Status service
//
// Polled on a timer, cached persistently, and never awaited by the redirect
// path. No browsing data is sent: the request is a fixed URL with no parameters
// and no credentials, identical for every user.
// ============================================================

function parseStatus(payload) {
    if (!payload || !Array.isArray(payload.hosts)) {
        return null;
    }

    const hosts = {};

    for (const host of payload.hosts) {
        // Ignore anything the manifest can't grant a redirect to anyway.
        if (!host || typeof host.domain !== "string" || !PERMITTED_DOMAINS.has(host.domain)) {
            continue;
        }

        hosts[host.domain] = {
            healthy: host.healthy === true,
            points: typeof host.points === "number" ? host.points : null,
            ping: typeof host.ping_avg === "number" ? host.ping_avg : null,
            isBadHost: host.is_bad_host === true
        };
    }

    return Object.keys(hosts).length > 0 ? hosts : null;
}

function persistStatus() {
    return browser.storage.local
        .set({ [STATUS_KEY]: { hosts: statusHosts, fetchedAt: statusFetchedAt } })
        .catch(() => {});
}

async function refreshStatus() {
    const now = Date.now();

    if (now < statusBackoffUntil) {
        return;
    }

    if (statusHosts && (now - statusFetchedAt) < STATUS_REFRESH_MS) {
        return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATUS_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(STATUS_API, {
            method: "GET",
            credentials: "omit",
            cache: "no-store",
            signal: controller.signal
        });

        if (response.status === 429) {
            statusBackoffUntil = Date.now() + STATUS_BACKOFF_MS;
            console.warn("[Twitter → Nitter] Status service rate limited; backing off.");
            return;
        }

        if (response.status !== 200) {
            statusBackoffUntil = Date.now() + STATUS_RETRY_MS;
            return;
        }

        const parsed = parseStatus(await response.json());

        if (!parsed) {
            statusBackoffUntil = Date.now() + STATUS_RETRY_MS;
            return;
        }

        statusHosts = parsed;
        statusFetchedAt = Date.now();
        statusBackoffUntil = 0;

        recomputeRanking();
        persistStatus();
    } catch {
        // Unavailable, aborted, or malformed. Keep whatever we already had and
        // carry on with the shipped list plus local health.
        statusBackoffUntil = Date.now() + STATUS_RETRY_MS;
    } finally {
        clearTimeout(timer);
    }
}


// ============================================================
// Local health, learned from real navigations
// ============================================================

function recordLocal(origin, state) {
    localHealth[origin] = {
        state: state,
        at: Date.now()
    };

    recomputeRanking();

    browser.storage.local.set({ [HEALTH_KEY]: localHealth }).catch(() => {});
}

// A 404 is Nitter answering that a user or tweet does not exist; that is a
// legitimate result, not a broken instance. Only responses that mean the
// instance itself could not serve us count as failures.
function isHardFailure(statusCode) {
    return (
        statusCode === 401 ||
        statusCode === 403 ||
        statusCode === 429 ||
        statusCode >= 500
    );
}


// ============================================================
// Startup
// ============================================================

async function init() {
    try {
        await browser.storage.local.remove(LEGACY_KEYS);

        const stored = await browser.storage.local.get([STATUS_KEY, HEALTH_KEY]);
        const cachedStatus = stored && stored[STATUS_KEY];
        const cachedHealth = (stored && stored[HEALTH_KEY]) || {};

        // Keep the local cache bounded to the manifest-permitted origins.
        localHealth = {};

        for (const origin of PERMITTED_ORIGINS) {
            if (cachedHealth[origin]) {
                localHealth[origin] = cachedHealth[origin];
            }
        }

        if (
            cachedStatus &&
            cachedStatus.hosts &&
            typeof cachedStatus.fetchedAt === "number" &&
            (Date.now() - cachedStatus.fetchedAt) < STATUS_STALE_MS
        ) {
            statusHosts = cachedStatus.hosts;
            statusFetchedAt = cachedStatus.fetchedAt;
        }

        recomputeRanking();
    } catch {
        recomputeRanking();
    }

    refreshStatus();
}

init();
setInterval(refreshStatus, STATUS_REFRESH_MS);


// ============================================================
// Path and host handling
// ============================================================

function isRedirectablePath(pathname) {
    if (pathname.startsWith("/i/")) {
        return SUPPORTED_I_PATH.test(pathname);
    }

    return !UNSUPPORTED_PREFIXES.some(
        prefix => pathname === prefix || pathname.startsWith(prefix + "/")
    );
}


// ============================================================
// Redirect loop circuit breaker
//
// Protection against a pathological instance that redirects back to X. It is
// not a fallback: in normal operation it never fires.
// ============================================================

const loopGuard = new Map();

function breakerOpen(tabId) {
    const entry = loopGuard.get(tabId);

    return Boolean(entry && entry.suppressUntil && Date.now() < entry.suppressUntil);
}

function noteRedirect(tabId) {
    const now = Date.now();
    const entry = loopGuard.get(tabId);

    if (!entry || (now - entry.first) > LOOP_WINDOW_MS) {
        loopGuard.set(tabId, { first: now, count: 1, suppressUntil: 0 });
        return;
    }

    entry.count++;

    if (entry.count > LOOP_MAX_REDIRECTS) {
        entry.suppressUntil = now + LOOP_SUPPRESS_MS;
        entry.first = now;
        entry.count = 0;

        console.warn(
            "[Twitter → Nitter] Redirect loop detected; pausing interception for this tab."
        );
    }
}


// ============================================================
// Interception
//
// Synchronous: reads only in-memory state and returns a redirect immediately.
// Nothing here awaits storage, the status service, or any probe.
// ============================================================

const activeRedirects = new Map();

browser.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.type !== "main_frame") {
            return {};
        }

        // tabId is -1 for requests not tied to a real tab, e.g. Firefox's
        // speculative/predictive connections for address-bar suggestions.
        // There is no tab to redirect, and tracking a record keyed by -1
        // would let it collide with -- and cascade unrelated fallback
        // attempts against -- every other such phantom request.
        if (details.tabId < 0) {
            return {};
        }

        let url;

        try {
            url = new URL(details.url);
        } catch {
            return {};
        }

        if (!TWITTER_HOSTS.has(url.hostname) || !isRedirectablePath(url.pathname)) {
            return {};
        }

        if (breakerOpen(details.tabId)) {
            return {};
        }

        const origin = pickInstance();

        if (!origin) {
            return {};
        }

        const path = url.pathname + url.search;

        // A new X interception on this tab supersedes whatever the tab was
        // doing before; clear any watchdog left over from that prior attempt
        // so it can't fire later and act on this new record instead.
        clearWatchdog(details.tabId);
        activeRedirects.set(details.tabId, { path: path, tried: [origin], timer: null, switching: false });
        noteRedirect(details.tabId);
        armWatchdog(details.tabId, origin);

        return { redirectUrl: origin + path };
    },
    { urls: TWITTER_URL_PATTERNS, types: ["main_frame"] },
    ["blocking"]
);


// ============================================================
// Learn from the outcome of the user's real navigation
//
// This replaces synthetic probing entirely. It costs no extra requests, and it
// observes what a real browser sees, including instances behind a challenge
// that a background fetch could never pass.
// ============================================================

function originOf(rawUrl) {
    try {
        const origin = new URL(rawUrl).origin;

        return PERMITTED_ORIGINS.has(origin) ? origin : null;
    } catch {
        return null;
    }
}

function clearWatchdog(tabId) {
    const record = activeRedirects.get(tabId);

    if (record && record.timer) {
        clearTimeout(record.timer);
        record.timer = null;
    }
}

function armWatchdog(tabId, origin) {
    const record = activeRedirects.get(tabId);

    if (!record) {
        return;
    }

    clearWatchdog(tabId);
    record.currentOrigin = origin;

    record.timer = setTimeout(() => {
        recordLocal(origin, "BROKEN");
        switchInstance(tabId, origin, {
            skipCommittedCheck: true,
            reason: "did not respond in time"
        });
    }, NAV_TIMEOUT_MS);
}

async function switchInstance(tabId, origin, { skipCommittedCheck = false, reason = "failed" } = {}) {
    const record = activeRedirects.get(tabId);

    // The breaker guards new X interceptions (onBeforeRequest) against a
    // genuine redirect loop. It must not also gate recovery here: hopping
    // between Nitter instances within one navigation is expected, bounded by
    // the instance list, and unrelated to the X-loop scenario the breaker
    // exists for. Gating it here previously stranded users on a broken
    // instance whenever several real failures happened in quick succession.
    // A live network event for an instance we've already given up on (e.g.
    // its onErrorOccurred arriving after the watchdog already moved on to
    // the next instance) must not touch the record of whatever we're
    // currently tracking instead.
    // record.switching blocks a second call (e.g. a late onErrorOccurred
    // arriving while the watchdog's own switch is still awaiting tabs.get)
    // from acting on the same attempt twice.
    if (!record || record.currentOrigin !== origin || record.switching) {
        return;
    }

    record.switching = true;

    let livePath;

    if (skipCommittedCheck) {
        // Nothing committed for this attempt: either the watchdog timed out
        // waiting for a response, or the request failed at the network level
        // (onErrorOccurred -- offline, DNS failure, connection refused,
        // aborted) before any document loaded. In both cases the tab's URL
        // still reflects whatever page it was on *before* the redirect (or is
        // absent entirely, since this extension has no "tabs" permission) --
        // never the failed instance. Reading it here would misidentify the
        // failure as the user navigating away and abandon the fallback. Use
        // the path we originally sent the tab to instead.
        livePath = record.path;
    } else {
        // onCompleted with a hard-failure status: the instance actually
        // returned an HTTP response, so the request committed and the tab's
        // URL reflects it. Confirm the tab is still on the instance that just
        // failed before redirecting it, so a stale event can't hijack
        // whatever the user is looking at now. Only the origin is checked,
        // not the exact path: the instance itself may have issued its own
        // redirect (e.g. /i/web/status/<id> -> /i/status/<id>) before
        // failing, and that is still the same attempt, not a user navigating
        // away.
        let currentUrl;

        try {
            currentUrl = new URL((await browser.tabs.get(tabId)).url);
        } catch {
            clearWatchdog(tabId);
            activeRedirects.delete(tabId);
            return;
        }

        // A new X interception can replace this tab's record while the
        // tabs.get() above was in flight. Re-fetch and confirm it's still the
        // same attempt before touching anything.
        if (activeRedirects.get(tabId) !== record || record.currentOrigin !== origin) {
            record.switching = false;
            return;
        }

        if (currentUrl.origin !== origin) {
            clearWatchdog(tabId);
            activeRedirects.delete(tabId);
            return;
        }

        // Use the tab's live path, not record.path: the instance may have
        // redirected the user to a different path before failing.
        livePath = currentUrl.pathname + currentUrl.search;
    }

    clearWatchdog(tabId);

    if (!record.tried.includes(origin)) {
        record.tried.push(origin);
    }

    const next = pickInstance(record.tried);

    if (!next) {
        // Every configured instance has been tried for this navigation. Leave
        // the user where they are rather than looping.
        console.log(
            `[Twitter → Nitter] ${origin} ${reason}; every configured instance already tried for this navigation, leaving as-is.`
        );
        activeRedirects.delete(tabId);
        return;
    }

    console.log(`[Twitter → Nitter] ${origin} ${reason}; trying ${next}.`);

    record.tried.push(next);
    record.switching = false;
    armWatchdog(tabId, next);

    browser.tabs
        .update(tabId, { url: next + livePath })
        .catch(() => {});
}

// A navigation can land on a configured Nitter instance without ever going
// through our own X redirect: a search result, a bookmark, or a typed URL.
// Track it the same way so a failure there gets the same automatic fallback,
// but only when it arrived from outside Nitter -- if the user is already
// browsing Nitter and clicks an internal link that fails, leave it alone
// rather than hijacking navigation they're already in the middle of.
browser.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.type !== "main_frame" || details.tabId < 0) {
            return;
        }

        if (activeRedirects.has(details.tabId)) {
            return;
        }

        const origin = originOf(details.url);

        if (!origin) {
            return;
        }

        if (details.originUrl && originOf(details.originUrl)) {
            return;
        }

        let url;

        try {
            url = new URL(details.url);
        } catch {
            return;
        }

        activeRedirects.set(details.tabId, {
            path: url.pathname + url.search,
            tried: [origin],
            timer: null,
            switching: false
        });
        armWatchdog(details.tabId, origin);
    },
    { urls: NITTER_URL_PATTERNS, types: ["main_frame"] }
);

// Nitter renders its own instance-level failures (rate limit, no auth
// tokens) into a generic ".error-panel" element -- the same one it uses for
// "user not found" / "tweet not found", per Nitter's own renderError() in
// src/views/general.nim. Presence alone can't tell those apart, so the
// panel's own text is matched against known failure phrases; a plain
// not-found message won't match and is correctly left alone (see
// isHardFailure's 404 handling for the same principle).
//
// An operator's own shutdown page (e.g. a static "this instance is down"
// notice) isn't rendered by Nitter at all -- confirmed live 2026-08-26 when
// both nitter.tiekoetter.com and nitter.catsarch.com went down with their
// own custom pages after X Corp's cease-and-desist against the upstream
// Nitter project itself, using wording no fixed phrase list could have
// anticipated. Checking for the *absence* of Nitter's own template markers
// (the same ones the CI markup check already trusts) catches any such page
// regardless of wording.
//
// That same absence-of-markers check would also misfire on a Cloudflare
// interactive challenge page, which is a transient state that resolves into
// a real Nitter page once solved (confirmed live 2026-08-26 -- an earlier
// test succeeded after ~30s), not a failure. Its own well-known "Just a
// moment..." title is checked first and explicitly excluded.
//
// Injected from check-page.js as a file, not an inline code string: some
// pages (e.g. a Nitter operator's own custom shutdown page) serve a strict
// CSP that blocks inline script injection outright, confirmed live
// 2026-08-26 against nitter.catsarch.com's own shutdown page. A file-based
// content script isn't subject to the page's CSP the same way.
//
// Only ever called for the tab's currently tracked attempt, never for
// ordinary Nitter browsing outside one.
async function pageShowsFailure(tabId) {
    try {
        const results = await browser.tabs.executeScript(tabId, {
            file: "check-page.js"
        });

        return Boolean(results && results[0]);
    } catch {
        return false;
    }
}

browser.webRequest.onCompleted.addListener(
    async (details) => {
        if (details.type !== "main_frame") {
            return;
        }

        const origin = originOf(details.url);

        if (!origin) {
            return;
        }

        // Health is recorded for the instance regardless of whether it's the
        // one we're still tracking: a live network event for an instance we
        // already gave up on (its request kept running after our watchdog
        // moved on) is still accurate signal about that instance. Only the
        // state-machine actions (watchdog, fallback, record deletion) are
        // restricted to the attempt currently being tracked.
        const record = activeRedirects.get(details.tabId);
        const isCurrent = Boolean(record && record.currentOrigin === origin);

        if (isCurrent) {
            clearWatchdog(details.tabId);
        }

        if (isHardFailure(details.statusCode)) {
            recordLocal(origin, "BROKEN");

            if (isCurrent) {
                switchInstance(details.tabId, origin, {
                    reason: `returned HTTP ${details.statusCode}`
                });
            } else {
                console.log(
                    `[Twitter → Nitter] ${origin} returned HTTP ${details.statusCode} for an attempt already superseded; ignoring.`
                );
            }

            return;
        }

        if (isCurrent && await pageShowsFailure(details.tabId)) {
            recordLocal(origin, "BROKEN");
            switchInstance(details.tabId, origin, {
                reason: "rendered a soft failure page"
            });

            return;
        }

        recordLocal(origin, "OK");

        if (isCurrent) {
            activeRedirects.delete(details.tabId);
        }
    },
    { urls: NITTER_URL_PATTERNS, types: ["main_frame"] }
);

browser.webRequest.onErrorOccurred.addListener(
    (details) => {
        if (details.type !== "main_frame") {
            return;
        }

        const origin = originOf(details.url);

        if (!origin) {
            return;
        }

        const record = activeRedirects.get(details.tabId);
        const isCurrent = Boolean(record && record.currentOrigin === origin);

        if (isCurrent) {
            clearWatchdog(details.tabId);
        }

        recordLocal(origin, "BROKEN");

        if (isCurrent) {
            switchInstance(details.tabId, origin, {
                skipCommittedCheck: true,
                reason: "failed to load"
            });
        } else {
            console.log(
                `[Twitter → Nitter] ${origin} failed to load for an attempt already superseded; ignoring.`
            );
        }
    },
    { urls: NITTER_URL_PATTERNS, types: ["main_frame"] }
);


// ============================================================
// Per-tab cleanup
// ============================================================

browser.tabs.onRemoved.addListener((tabId) => {
    clearWatchdog(tabId);
    activeRedirects.delete(tabId);
    loopGuard.delete(tabId);
});
