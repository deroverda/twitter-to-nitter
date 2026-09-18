// Injected via tabs.executeScript({file: ...}) rather than an inline code
// string, because some pages (e.g. a Nitter operator's own custom shutdown
// page) serve a strict CSP that blocks inline script injection outright --
// confirmed live 2026-08-26 against nitter.catsarch.com's shutdown page,
// which sends "default-src 'none'". A file-based content script isn't
// subject to the page's CSP the same way an inline one is.
//
// Returns one of four values: false when the page is fine (a real page or a
// "not found" result); "challenge" for an anti-bot interstitial that hasn't
// resolved yet; "fail" for a confidently-identified instance failure (a named
// rate-limit/auth phrase, in content or Nitter's own error panel); "unknown"
// when the page merely doesn't look like Nitter's template at all. "unknown"
// still triggers fallback for this navigation (the page isn't usable either
// way), but the caller never treats it as a confirmed fleet-wide failure -- a
// real Nitter template change would otherwise get every instance judged
// broken at once. "challenge" never triggers fallback: the tab is left alone
// so the user can complete it.
(() => {
    // "rate limit" (no "-ed") also matches "rate limit exceeded" and "rate
    // limiting", wordings "rate limited" alone missed. The gates below
    // (structural .error-panel match, or no-content-rendered for the body
    // scan) already carry the false-positive protection that justified the
    // narrower phrase, so broadening it here doesn't weaken either gate.
    const INSTANCE_FAILURE_PHRASES = ["rate limit", "no auth tokens", "too many requests"];

    // 1. Anti-bot interstitial still resolving. This is transient -- it turns
    //    into a real Nitter page once the challenge passes -- so it is not a
    //    failure, and the caller must not redirect away from it mid-solve.
    //    Reported distinctly from a working page so the caller can still keep
    //    the instance out of the next fresh redirect. Cloudflare's challenge
    //    runtime always loads from
    //    /cdn-cgi/challenge-platform and its interactive form is
    //    #challenge-form; the localized "just a moment" title is only a cheap
    //    secondary signal, not the primary gate (it is English-only and
    //    Cloudflare translates it).
    if (
        document.querySelector('script[src*="/cdn-cgi/challenge-platform"]') ||
        document.querySelector("#challenge-form") ||
        (document.title || "").toLowerCase().includes("just a moment")
    ) {
        return "challenge";
    }

    // 2. Only an HTML document can be a Nitter page. RSS, JSON and plain-text
    //    are legitimate instance responses (Nitter serves RSS at /<user>/rss)
    //    and must never be judged by markup. An HTML root is an HTMLElement;
    //    an XML root (e.g. <rss>) is a plain Element.
    if (!(document.documentElement instanceof HTMLElement)) {
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
        return "fail";
    }

    // 5. Nitter's own error panel. It is also used for "user not found" /
    //    "tweet not found", which are legitimate answers, so the panel's text
    //    still has to name a known instance-level failure. Unlike step 4, this
    //    is NOT gated on !hasContent: a dedicated error panel is a precise,
    //    structural signal (a real tweet's text can't land inside it), not a
    //    loose body-text scan, so the false-positive risk step 4's gate exists
    //    for doesn't apply here. An explicit named failure is authoritative
    //    even if some content also rendered -- matching the README's own
    //    description of this behaviour.
    const panel = document.querySelector(".error-panel");

    if (panel) {
        const text = (panel.textContent || "").toLowerCase();

        return INSTANCE_FAILURE_PHRASES.some(phrase => text.includes(phrase)) ? "fail" : false;
    }

    // 6. Doesn't render as Nitter at all: an operator's own shutdown or
    //    maintenance page, whatever its wording. Checking for the absence of
    //    Nitter's own template markers catches these regardless of phrasing.
    //
    //    A "/css/style.css" link is deliberately not one of those markers,
    //    even though the CI markup check still counts it: operators replacing
    //    the page body commonly leave Nitter's static asset paths in place, so
    //    the link survives on pages the template never rendered. Counting it
    //    makes a shutdown notice pass as a healthy page, which fires no
    //    fallback and leaves the user sitting on it. The two markers below
    //    only appear when Nitter itself rendered the page.
    const looksLikeNitter = Boolean(
        document.querySelector('meta[property="og:site_name"][content="Nitter"]') ||
        document.querySelector(".inner-nav")
    );

    return looksLikeNitter ? false : "unknown";
})();
