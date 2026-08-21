const NITTER_INSTANCES = [
    "https://nitter.net",
    "https://nitter.poast.org",
    "https://nitter.privacyredirect.com",
    "https://xcancel.com",
    "https://lightbrd.com",
    "https://nitter.space",
    "https://nitter.tiekoetter.com",
    "https://nuku.trabun.org",
    "https://nitter.catsarch.com"
];

const TWITTER_HOSTS = new Set([
    "twitter.com",
    "www.twitter.com",
    "x.com",
    "www.x.com"
]);

const FAILURE_MESSAGES = [
    "Instance has been rate limited"
];

const pendingRedirects = new Map();

const CACHE_KEY = "workingInstance";
let cachedInstance = null;

browser.storage.local.get(CACHE_KEY).then((result) => {
    if (result[CACHE_KEY]) {
        cachedInstance = result[CACHE_KEY];
        console.log(
            `[Twitter → Nitter] Loaded cached instance: ${cachedInstance}`
        );
    }
});


// ============================================================
// Build instance order, trying the cached instance first
// ============================================================

const tabStatusCodes = new Map();

browser.webRequest.onCompleted.addListener(
    (details) => {
        if (details.type !== "main_frame") {
            return;
        }

        let url;

        try {
            url = new URL(details.url);
        } catch {
            return;
        }

        const isNitter =
            NITTER_INSTANCES.some(
                instance =>
                    url.origin === new URL(instance).origin
            );

        if (!isNitter) {
            return;
        }

        tabStatusCodes.set(details.tabId, details.statusCode);
    },
    { urls: NITTER_INSTANCES.map(instance => instance + "/*") }
);


function getOrderedInstances() {
    if (!cachedInstance || !NITTER_INSTANCES.includes(cachedInstance)) {
        return NITTER_INSTANCES;
    }

    return [
        cachedInstance,
        ...NITTER_INSTANCES.filter(
            instance => instance !== cachedInstance
        )
    ];
}


// ============================================================
// Twitter/X navigation
// ============================================================

browser.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId !== 0) {
        return;
    }

    let url;

    try {
        url = new URL(details.url);
    } catch {
        return;
    }

    if (!TWITTER_HOSTS.has(url.hostname)) {
        return;
    }

    const path =
        url.pathname +
        url.search +
        url.hash;

    const redirect = {
        originalUrl: details.url,
        path: path,
        instances: getOrderedInstances(),
        instanceIndex: 0
    };

    pendingRedirects.set(details.tabId, redirect);

    navigateToInstance(details.tabId, redirect);
});


// ============================================================
// Navigate to an instance
// ============================================================

async function navigateToInstance(tabId, redirect) {
    if (redirect.instanceIndex >= redirect.instances.length) {
        console.error(
            "[Twitter → Nitter] All instances failed."
        );

        pendingRedirects.delete(tabId);
        return;
    }

    const instance =
        redirect.instances[redirect.instanceIndex];

    const target =
        instance +
        redirect.path;

    console.log(
        `[Twitter → Nitter] Trying ${instance}`
    );

    try {
        await browser.tabs.update(tabId, {
            url: target
        });
    } catch (error) {
        console.error(
            "[Twitter → Nitter] Navigation error:",
            error
        );

        tryNextInstance(tabId, redirect);
    }
}


// ============================================================
// Detect completed Nitter navigation
// ============================================================

browser.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0) {
        return;
    }

    const redirect =
        pendingRedirects.get(details.tabId);

    if (!redirect) {
        return;
    }

    let url;

    try {
        url = new URL(details.url);
    } catch {
        return;
    }

    const isNitter =
        NITTER_INSTANCES.some(
            instance =>
                url.origin ===
                new URL(instance).origin
        );

    if (!isNitter) {
        return;
    }

    console.log(
        `[Twitter → Nitter] Loaded ${details.url}`
    );

    // Give Nitter a moment to finish rendering.
    setTimeout(() => {
        inspectNitterPage(
            details.tabId,
            redirect,
            url
        );
    }, 500);
});


// ============================================================
// Inspect the actual Nitter page
// ============================================================

async function inspectNitterPage(
    tabId,
    redirect,
    url
) {
    const statusCode = tabStatusCodes.get(tabId);

    if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) {
        console.log(
            `[Twitter → Nitter] ${url.origin} returned HTTP ${statusCode}.`
        );

        tryNextInstance(tabId, redirect);

        return;
    }

    try {
        const results =
            await browser.tabs.executeScript(
                tabId,
                {
                    code: `
                        ({
                            text: document.body
                                ? document.body.innerText
                                : "",

                            searchResults:
                                document.querySelectorAll(
                                    ".tweet-content.media-body"
                                ).length
                        })
                    `
                }
            );

        const page = results?.[0] || {};

        const text =
            page.text || "";

        const searchResults =
            page.searchResults || 0;


        // ----------------------------------------------------
        // Rate-limit / known failure
        // ----------------------------------------------------

        const rateLimited =
            FAILURE_MESSAGES.some(
                message =>
                    text.includes(message)
            );

        if (rateLimited) {
            console.log(
                `[Twitter → Nitter] ${url.origin} is rate limited.`
            );

            tryNextInstance(
                tabId,
                redirect
            );

            return;
        }


        // ----------------------------------------------------
        // Search validation
        // ----------------------------------------------------

        if (url.pathname === "/search") {

            if (searchResults === 0) {

                console.log(
                    `[Twitter → Nitter] ${url.origin} returned an empty search.`
                );

                tryNextInstance(
                    tabId,
                    redirect
                );

                return;
            }

            console.log(
                `[Twitter → Nitter] Search working on ${url.origin} (${searchResults} results).`
            );
        }


        // ----------------------------------------------------
        // Instance appears to work
        // ----------------------------------------------------

        console.log(
            `[Twitter → Nitter] Using ${url.origin}`
        );

        if (cachedInstance !== url.origin) {
            cachedInstance = url.origin;
            browser.storage.local.set({
                [CACHE_KEY]: url.origin
            });
        }

        pendingRedirects.delete(tabId);

    } catch (error) {

        console.error(
            "[Twitter → Nitter] Page inspection failed:",
            error
        );

        // Don't create an infinite redirect loop
        // if Firefox refuses script injection.
        pendingRedirects.delete(tabId);
    }
}


// ============================================================
// Try next instance
// ============================================================

function tryNextInstance(
    tabId,
    redirect
) {
    redirect.instanceIndex++;

    if (
        redirect.instanceIndex >=
        redirect.instances.length
    ) {
        console.error(
            "[Twitter → Nitter] No working instance found."
        );

        pendingRedirects.delete(tabId);

        return;
    }

    navigateToInstance(
        tabId,
        redirect
    );
}


// ============================================================
// Clean up closed tabs
// ============================================================

browser.tabs.onRemoved.addListener(
    (tabId) => {
        pendingRedirects.delete(tabId);
        tabStatusCodes.delete(tabId);
    }
);