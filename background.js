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

const STATUS_API = "https://status.d420.de/api/v1/instances";

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
// list once it reports the instance healthy, and drop it when it doesn't.
//
// It cannot introduce an origin outside this set: parseStatus() discards any
// host not in PERMITTED_DOMAINS, and candidateOrigins() intersects again at
// use. Firefox does NOT gate redirectUrl targets by host permission, so that
// filter -- not the platform -- is what confines the service to the manifest
// superset. The host permissions are still required, but for observing the
// outcome of a redirect (onCompleted / onErrorOccurred / executeScript) on
// the target instance; without them the fallback logic would go blind.
//
// Only the strict "https://host/*" permission shape is accepted. A
// path-scoped grant ("https://host/path/*") would otherwise collapse to the
// whole origin here and over-broaden originOf().
const PERMITTED_ORIGINS = new Set(
    (browser.runtime.getManifest().permissions || [])
        .filter(perm => /^https:\/\/[^/]+\/\*$/.test(perm))
        .map(perm => {
            try {
                return new URL(perm.replace(/\/\*$/, "")).origin;
            } catch {
                return null;
            }
        })
        .filter(origin => origin && origin !== new URL(STATUS_API).origin)
);

const PERMITTED_DOMAINS = new Set(
    Array.from(PERMITTED_ORIGINS, origin => new URL(origin).hostname)
);

// The status filter above is the only thing keeping the service inside the
// manifest superset. Fail loudly if the shipped seed list ever drifts outside
// what the manifest permits (CI checks this too, but not at runtime).
for (const seed of SEED_INSTANCES) {
    if (!PERMITTED_ORIGINS.has(seed)) {
        console.error(
            `[Twitter → Nitter] seed instance ${seed} has no matching host permission; ` +
            "fallback observation will not work for it."
        );
    }
}

// The ranking floor and candidate base must never include a seed the manifest
// doesn't actually permit -- redirecting to one would be unobservable (see the
// console.error above) since originOf() rejects its events outright.
const SAFE_SEED_INSTANCES = SEED_INSTANCES.filter(origin => PERMITTED_ORIGINS.has(origin));

const TWITTER_HOSTS = new Set([
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
    "m.twitter.com",
    "x.com",
    "www.x.com",
    "mobile.x.com",
    "m.x.com"
]);

const TWITTER_URL_PATTERNS = [
    "*://twitter.com/*",
    "*://www.twitter.com/*",
    "*://mobile.twitter.com/*",
    "*://m.twitter.com/*",
    "*://x.com/*",
    "*://www.x.com/*",
    "*://mobile.x.com/*",
    "*://m.x.com/*"
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

// Canonical status and list permalinks under /i/ that Nitter does serve.
// Nitter itself redirects /i/web/status/<id> to /i/status/<id>, so both are
// passed through. /i/lists/<id> and its /members page are real upstream
// routes too (src/routes/list.nim); everything else under /i/ -- spaces,
// articles, broadcasts, bookmarks -- is explicitly unsupported by Nitter
// itself (src/routes/unsupported.nim only allows "status", "lists", "user"),
// so leaving them blocked here matches Nitter's own stance, not just ours.
const SUPPORTED_I_PATH = /^\/i\/(?:(?:web\/)?status\/\d+|lists\/\d+(?:\/members)?)/;

// The service updates every 900s; polling faster than that gets rate limited.
const STATUS_REFRESH_MS = 15 * 60 * 1000;
const STATUS_RETRY_MS = 5 * 60 * 1000;
const STATUS_BACKOFF_MS = 60 * 60 * 1000;
const STATUS_STALE_MS = 6 * 60 * 60 * 1000;
const STATUS_FETCH_TIMEOUT_MS = 8000;

// Defensive only: the service returns a small, fixed-shape instance list, so
// this should never come close. Guards against a misconfigured or compromised
// endpoint returning an arbitrarily large body before it gets buffered and
// parsed in the background page.
const STATUS_MAX_BODY_BYTES = 1 * 1024 * 1024;

// How long a locally observed hard failure keeps an instance demoted.
const LOCAL_FAILURE_TTL_MS = 30 * 60 * 1000;

// If a redirected navigation neither completes nor errors within this window,
// treat the instance as hanging and move on. Firefox's own network timeout is
// far too long to leave the user staring at a blank tab.
const NAV_TIMEOUT_MS = 8000;

// Circuit breaker against pathological redirect loops. The only realistic
// live trigger is rapid *legitimate* X clicks (noteRedirect counts every new
// X interception, not just bounce-backs), so the threshold has to clear
// normal fast browsing -- clicking several X links from an aggregator page
// in quick succession is plausible and must not cut a tab off from
// interception. The suppression window is kept short so a false trip is
// only a brief inconvenience, not a lasting privacy regression.
const LOOP_WINDOW_MS = 10000;
const LOOP_MAX_REDIRECTS = 6;
const LOOP_SUPPRESS_MS = 10000;

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

let ranked = SAFE_SEED_INSTANCES.slice();


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

// The status data is trusted only while it is fresher than STATUS_STALE_MS.
// Past that -- the service has been unreachable for hours -- fall back to the
// seed list rather than keep promoting or ranking instances on stale data.
function freshStatusHosts() {
    if (statusHosts && (Date.now() - statusFetchedAt) < STATUS_STALE_MS) {
        return statusHosts;
    }

    return null;
}

function statusFor(origin) {
    const hosts = freshStatusHosts();

    return hosts ? (hosts[domainOf(origin)] || null) : null;
}

// Seed list, plus every status-service instance currently healthy and
// permitted by the manifest. Recomputed on each ranking pass, so the service
// adds and drops instances live within the manifest-permitted set.
function candidateOrigins() {
    const origins = new Set(SAFE_SEED_INSTANCES);
    const hosts = freshStatusHosts();

    if (hosts) {
        for (const [domain, info] of Object.entries(hosts)) {
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
        if (!host || typeof host.domain !== "string") {
            continue;
        }

        // DNS is case-insensitive and a domain can carry a trailing dot; normalise
        // before the permitted-set lookup so a service-side formatting change
        // doesn't silently drop an instance from live health data.
        const domain = host.domain.toLowerCase().replace(/\.$/, "");

        // Ignore anything the manifest can't grant a redirect to anyway.
        if (!PERMITTED_DOMAINS.has(domain)) {
            continue;
        }

        hosts[domain] = {
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

    // Cheap and idempotent: re-applies staleness (freshStatusHosts crossing
    // STATUS_STALE_MS demotes status-promoted instances back out) even when
    // this call does nothing else below, so a prolonged outage doesn't leave
    // stale-promoted instances ranked ahead of the seed list until some
    // unrelated navigation happens to trigger a recompute.
    recomputeRanking();

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

        const contentLength = Number(response.headers.get("content-length"));

        if (Number.isFinite(contentLength) && contentLength > STATUS_MAX_BODY_BYTES) {
            statusBackoffUntil = Date.now() + STATUS_RETRY_MS;
            console.warn("[Twitter → Nitter] Status response too large; ignoring.");
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
    // Only a BROKEN entry carries information (locallyBroken reads nothing
    // else). Recording OK just means "no longer known broken", so drop the
    // entry rather than let cleared failures pile up in storage.
    if (state === "BROKEN") {
        localHealth[origin] = { state: state, at: Date.now() };
    } else {
        delete localHealth[origin];
    }

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
        statusCode === 408 ||
        statusCode === 429 ||
        statusCode >= 500
    );
}

// onErrorOccurred fires for reasons that have nothing to do with the remote
// instance being broken -- the user's own tracking protection or another
// local policy can block a request too. Only a genuine network-level failure
// should persist a BROKEN mark that demotes the instance for other tabs and
// future navigations; the current attempt still falls back regardless (see
// the listener below), this only narrows what gets written to local health.
function isDefinitiveNetworkFailure(error) {
    return /^(?:NS_ERROR_NET_|NS_ERROR_CONNECTION_REFUSED$|NS_ERROR_UNKNOWN_HOST$)/.test(
        error || ""
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

        // Merge into whatever localHealth already holds rather than resetting
        // it: a real navigation's recordLocal() can land while the storage
        // read above is still pending, and clobbering that live write with a
        // stale disk snapshot would silently lose it. Cache only fills gaps;
        // it never overrides an entry already present. Bounded to permitted
        // origins either way.
        for (const origin of PERMITTED_ORIGINS) {
            if (cachedHealth[origin] && !localHealth[origin]) {
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

// True when a webRequest event belongs to the attempt currently tracked for
// its tab: same landing origin, and -- once we have captured it -- the same
// underlying request. The requestId check stops a stale event from a
// superseded request to the same instance (e.g. a second fast X navigation
// that happened to pick the same instance) from being taken for the live one.
function sameAttempt(record, origin, requestId) {
    return Boolean(
        record &&
        record.currentOrigin === origin &&
        (record.requestId === undefined || record.requestId === requestId)
    );
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

    record.timer = setTimeout(async () => {
        // Liveness check before treating this as an instance failure. The
        // watchdog is only cleared by an outcome event for this origin, a new
        // X interception, or tab removal -- so if the user navigates the tab
        // away mid-load, nothing else stops this timer from firing and yanking
        // them back to a Nitter page. tab.url is readable for permitted
        // origins and x.com (host permissions) and undefined for anything
        // else; tab.status is always readable.
        let tabMovedAway = false;

        try {
            const tab = await browser.tabs.get(tabId);
            const tabUrl = tab && tab.url;
            let tabOrigin = null;

            if (tabUrl) {
                try {
                    tabOrigin = new URL(tabUrl).origin;
                } catch {
                    tabOrigin = null;
                }
            }

            // No readable URL: the tab is on an unpermitted site, i.e. the
            // user navigated away. Or: finished loading a *different permitted
            // instance* than the one we are waiting on (a redirect chain or a
            // manual navigation landed there). A genuine slow load still reads
            // as status "loading" showing the pre-redirect page -- often
            // about:blank, whose origin is not in PERMITTED_ORIGINS -- so this
            // only catches real departures.
            tabMovedAway = !tabUrl ||
                (tab.status === "complete" && PERMITTED_ORIGINS.has(tabOrigin) && tabOrigin !== origin);
        } catch {
            // Tab gone.
            tabMovedAway = true;
        }

        // A new attempt (re-arm, or a fresh X interception) may have replaced
        // this record while tabs.get was in flight. If so, it is not ours to
        // touch.
        if (activeRedirects.get(tabId) !== record || record.currentOrigin !== origin) {
            return;
        }

        if (tabMovedAway) {
            clearWatchdog(tabId);
            activeRedirects.delete(tabId);
            return;
        }

        recordLocal(origin, "BROKEN");
        switchInstance(tabId, origin, {
            skipCommittedCheck: true,
            reason: "did not respond in time"
        });
    }, NAV_TIMEOUT_MS);
}

// Self-contained data: URL, so this needs no packaged file, no new
// permission, and no web_accessible_resources entry -- shown only when every
// configured instance has been tried and failed for one navigation.
function terminalFailurePage(path) {
    const safePath = String(path).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));

    const html =
        "<!doctype html><meta charset=\"utf-8\"><title>Twitter/X to Nitter</title>" +
        "<body style=\"font-family:sans-serif;max-width:32em;margin:4em auto;line-height:1.5;color:#1a1a1a\">" +
        "<h1>Every Nitter instance failed</h1>" +
        "<p>Every configured instance was tried for this page and none of them worked right now.</p>" +
        `<p><a href="https://x.com${safePath}">Try again</a></p>` +
        "</body>";

    return "data:text/html;charset=utf-8," + encodeURIComponent(html);
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
        // Every configured instance has been tried for this navigation. Show
        // a terminal failure page rather than leaving the user stranded on
        // whatever broken page the last instance rendered, with no
        // explanation of what happened or a way to retry.
        console.log(
            `[Twitter → Nitter] ${origin} ${reason}; every configured instance already tried for this navigation.`
        );
        browser.tabs.update(tabId, { url: terminalFailurePage(livePath) }).catch(() => {});
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

// Fires for every main_frame request to a permitted instance.
//
// If an attempt is already in flight for this tab, this request continues it:
// our own fallback redirect, an instance's self-redirect (/i/web/status ->
// /i/status), or a hop to another permitted instance. Follow it -- move
// currentOrigin, add it to tried, re-arm the watchdog, record the real request
// id. Without this a cross-origin hop leaves the watchdog pinned to the old
// origin, so it fires 8s later and yanks the user off a page that loaded fine.
//
// Otherwise the user navigated to an instance some other way -- a search
// result, a bookmark, a typed URL, or a link clicked from within Nitter
// itself; track it for the same fallback in every case, so a failure reached
// by browsing inside an instance (e.g. an individual tweet permalink that
// turns out to be rate-limited) falls back exactly like one reached by a
// fresh redirect, instead of stranding the user on it.
browser.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.type !== "main_frame" || details.tabId < 0) {
            return;
        }

        const origin = originOf(details.url);

        if (!origin) {
            return;
        }

        const record = activeRedirects.get(details.tabId);

        if (record) {
            record.requestId = details.requestId;

            if (!record.tried.includes(origin)) {
                record.tried.push(origin);
            }

            armWatchdog(details.tabId, origin);
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
            switching: false,
            requestId: details.requestId
        });
        armWatchdog(details.tabId, origin);
    },
    { urls: NITTER_URL_PATTERNS, types: ["main_frame"] }
);

// Decides whether the loaded page is an instance-level failure to fall away
// from. The full logic (and why each branch exists) lives in check-page.js;
// in short it ignores still-resolving anti-bot challenge pages and non-HTML
// responses, treats a page with no rendered content plus a known failure
// phrase as a failure (covering forks that don't use Nitter's .error-panel),
// matches .error-panel text against those phrases (so a plain "not found" is
// left alone), and treats anything that doesn't render as Nitter at all as a
// failure (an operator's own shutdown page, whatever its wording).
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
        const isCurrent = sameAttempt(record, origin, details.requestId);

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
            // executeScript above is async: the tab may have navigated during
            // it, in which case check-page.js ran against a different document
            // and its verdict is not about this instance. Re-confirm before
            // acting on it.
            if (sameAttempt(activeRedirects.get(details.tabId), origin, details.requestId)) {
                recordLocal(origin, "BROKEN");
                switchInstance(details.tabId, origin, {
                    reason: "rendered a soft failure page"
                });
            }

            return;
        }

        recordLocal(origin, "OK");

        if (sameAttempt(activeRedirects.get(details.tabId), origin, details.requestId)) {
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
        const isCurrent = sameAttempt(record, origin, details.requestId);

        // NS_BINDING_ABORTED means the load was cancelled, not that the
        // instance failed: the user pressed Stop, or started a new navigation
        // before this one finished. Treating it as a failure both demotes a
        // healthy instance and can force the tab back onto a Nitter page the
        // user was navigating away from. Just end the attempt.
        if (details.error === "NS_BINDING_ABORTED") {
            if (isCurrent) {
                clearWatchdog(details.tabId);
                activeRedirects.delete(details.tabId);
            }

            return;
        }

        if (isCurrent) {
            clearWatchdog(details.tabId);
        }

        if (isDefinitiveNetworkFailure(details.error)) {
            recordLocal(origin, "BROKEN");
        }

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
