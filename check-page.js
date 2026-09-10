// Injected via tabs.executeScript({file: ...}) rather than an inline code
// string, because some pages (e.g. a Nitter operator's own custom shutdown
// page) serve a strict CSP that blocks inline script injection outright --
// confirmed live 2026-08-26 against nitter.catsarch.com's shutdown page,
// which sends "default-src 'none'". A file-based content script isn't
// subject to the page's CSP the same way an inline one is.
//
// Returns true when the loaded page is an instance-level failure the
// extension should fall away from, false for anything it should leave alone
// (a real page, a "not found" result, or a challenge page still resolving).
(() => {
    const INSTANCE_FAILURE_PHRASES = ["rate limited", "no auth tokens"];

    // 1. Anti-bot interstitial still resolving. This is transient -- it turns
    //    into a real Nitter page once the challenge passes -- so it is not a
    //    failure. Cloudflare's challenge runtime always loads from
    //    /cdn-cgi/challenge-platform and its interactive form is
    //    #challenge-form; the localized "just a moment" title is only a cheap
    //    secondary signal, not the primary gate (it is English-only and
    //    Cloudflare translates it).
    if (
        document.querySelector('script[src*="/cdn-cgi/challenge-platform"]') ||
        document.querySelector("#challenge-form") ||
        (document.title || "").toLowerCase().includes("just a moment")
    ) {
        return false;
    }

    // 2. Only an HTML document can be a Nitter page. RSS, JSON and plain-text
    //    are legitimate instance responses (Nitter serves RSS at /<user>/rss)
    //    and must never be judged by markup.
    if (!(document.documentElement instanceof HTMLHtmlElement)) {
        return false;
    }

    // 3. A working Nitter page always renders one of these content containers,
    //    including for an empty profile or an empty search result.
    const hasContent = Boolean(
        document.querySelector(".timeline, .timeline-container, .thread, .profile-card")
    );

    const bodyText = ((document.body && document.body.innerText) || "").toLowerCase();

    // 4. Failure phrase anywhere on the page, but only when no content
    //    rendered -- a real tweet or bio could quote "rate limited". This
    //    catches forks that render the error outside a .error-panel.
    if (!hasContent && INSTANCE_FAILURE_PHRASES.some(phrase => bodyText.includes(phrase))) {
        return true;
    }

    // 5. Nitter's own error panel. It is also used for "user not found" /
    //    "tweet not found", which are legitimate answers, so the panel's text
    //    still has to name a known instance-level failure.
    const panel = document.querySelector(".error-panel");

    if (panel) {
        const text = (panel.textContent || "").toLowerCase();

        return INSTANCE_FAILURE_PHRASES.some(phrase => text.includes(phrase));
    }

    // 6. Doesn't render as Nitter at all: an operator's own shutdown or
    //    maintenance page, whatever its wording. Checking for the absence of
    //    Nitter's own template markers (the same ones the CI markup check
    //    trusts) catches these regardless of phrasing.
    const looksLikeNitter = Boolean(
        document.querySelector('meta[property="og:site_name"][content="Nitter"]') ||
        document.querySelector('link[href*="/css/style.css"]') ||
        document.querySelector(".inner-nav")
    );

    return !looksLikeNitter;
})();
