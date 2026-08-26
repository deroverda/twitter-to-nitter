// Injected via tabs.executeScript({file: ...}) rather than an inline code
// string, because some pages (e.g. a Nitter operator's own custom shutdown
// page) serve a strict CSP that blocks inline script injection outright --
// confirmed live 2026-08-26 against nitter.catsarch.com's shutdown page,
// which sends "default-src 'none'". A file-based content script isn't
// subject to the page's CSP the same way an inline one is.
//
// Keep INSTANCE_FAILURE_PHRASES here in sync with the same list in
// background.js's pageShowsFailure() -- duplicated because executeScript
// has no way to pass data into a file-based script in this API.
(() => {
    const INSTANCE_FAILURE_PHRASES = ["rate limited", "no auth tokens"];

    if ((document.title || "").toLowerCase().includes("just a moment")) {
        return false;
    }

    const looksLikeNitter = Boolean(
        document.querySelector('meta[property="og:site_name"][content="Nitter"]') ||
        document.querySelector('link[href*="/css/style.css"]') ||
        document.querySelector(".inner-nav")
    );

    if (!looksLikeNitter) {
        return true;
    }

    const panel = document.querySelector(".error-panel");

    if (!panel) {
        return false;
    }

    const text = (panel.textContent || "").toLowerCase();

    return INSTANCE_FAILURE_PHRASES.some((phrase) => text.includes(phrase));
})();
