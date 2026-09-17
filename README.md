<div align="center">

<img src="logo.png" width="512" alt="Twitter/X to Nitter">

</div>

# Twitter/X to Nitter

![License](https://img.shields.io/badge/license-MIT-blue)
![Release](https://img.shields.io/github/v/release/deroverda/twitter-to-nitter)
![Last Commit](https://img.shields.io/github/last-commit/deroverda/twitter-to-nitter)

A tiny Firefox extension that redirects `x.com` and `twitter.com` to a working Nitter frontend.

The X request is **intercepted before it leaves your browser**. X never receives the navigation or gets to load first.

> [!NOTE]
> **August 2026 cease-and-desist, September recovery.** On 24 August 2026, X Corp. sent cease-and-desist letters demanding the takedown of Nitter instances and the upstream [Nitter project](https://github.com/zedeus/nitter), causing most public instances to shut down. In early September, after legal advice, the project announced it would continue ("Nitter lives") and instances began returning. The upstream repository was archived on 11 September 2026; individual Nitter-compatible instances remain separately operated. This extension now follows the [live instance health service](https://status.d420.de/), activating and dropping permitted instances as their status changes. The fleet remains smaller and less stable than before; if all reachable instances fail, the extension shows a failure page rather than sending you to X.

> **Firefox Add-ons (AMO):** No public listing is planned for now. Releases are private, unlisted signed builds (see [Install](#install)).

## What it does

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/flow-diagram-dark.svg">
    <img src="assets/flow-diagram.svg" width="600" alt="Redirect flow: try an instance, check whether it is rate limited, blocked, unreachable, or not a real Nitter page, then retry, stay, or show a failure page once retries run out">
  </picture>
</p>

When you open an X/Twitter link:

1. The request is intercepted and redirected to Nitter **before it is sent**. Nothing is fetched or checked first.
2. The instance is selected from a locally cached ranking, refreshed in the background.
3. If the instance is rate limited, blocked, or unreachable, the extension falls back to the next candidate.

**Preferred instance:** Click the toolbar icon while on a Nitter page to prefer that instance for future fresh redirects. This is useful because per-instance settings and capabilities such as RSS and NSFW support do not follow automatic switches, and the health ranking cannot know your preferences. If the preferred instance fails, normal fallback still applies, and the preference remains set for when it recovers.

### Instance selection

The candidate list combines two independent sources:

* **Fleet health:** The [Nitter Instance Health](https://status.d420.de/) service is polled about every 15 minutes and cached locally - see [Instances](#instances) for which domains it can activate and how the seed list works.
* **Your results:** Actual navigation outcomes are specific to your network and take priority over the service's view. The extension sends **no probe traffic** to Nitter instances.

The extension also:

* Preserves the original path and query string.
* Redirects canonical status URLs including `/i/status/<id>` and `/i/web/status/<id>`.
* Leaves X-only surfaces such as `/home`, `/notifications`, `/messages`, `/settings`, `/explore`, `/compose`, `/intent`, `/share`, `/login`, `/logout`, `/account`, `/tos`, `/privacy`, and the rest of `/i/*` on X.
* Treats a 404 as a valid Nitter response.
* Remembers instances that failed for you and temporarily demotes them, for longer the worse the failure was and the more often it repeats. A rate limit clears in minutes; a host that stops resolving is held down far longer.
* Temporarily stops redirecting a tab if it detects a redirect loop.
* Detects failures regardless of how you reached Nitter: the extension's redirect, search result, bookmark, typed URL, or link clicked while already browsing Nitter.
* Detects HTTP 200 pages that are actually instance failures, including custom operator shutdown pages, rate-limit pages, exhausted auth tokens, and known Nitter instance-error panels. A normal "not found" page is not treated as a failure.
* Never navigates away from a human-verification challenge, so you can finish solving it. The instance is briefly deprioritised so the next fresh redirect prefers one that is not challenging you; completing the challenge clears that immediately.
* Performs the page-content check only while the extension is actively deciding a tracked navigation, not during ordinary Nitter browsing.

## Instances

The extension can use any instance currently reported healthy by the [health service](https://status.d420.de/) **provided its domain is already in `manifest.json` host permissions**.

**Seed list** (`SEED_INSTANCES` in `background.js`):

* `nitter.jaydenha.uk`
* `nitter.click`
* `nitter.meowing.monster`
* `nitter.netbub.com`
* `nitter.miningtcup.me`
* `shitter.thepixora.com`
* `nitter.xitter.cc`

**Permitted superset** (`manifest.json`):

The seed list plus `nitter.kareem.one`, which was dropped from the seed list in September 2026 after repeated 502s but stays permitted so it can return without a release if it recovers.

The health service can activate or deprioritise these domains between releases, but cannot introduce new domains. Hosts outside the manifest are discarded and re-checked at use time. Seed instances are never completely removed; unhealthy ones are simply pushed down the ranking.

`lightbrd.com` is permanently excluded because it does not proxy images/video/GIFs and loads Microsoft Clarity analytics, according to [zedeus/nitter#1209](https://github.com/zedeus/nitter/issues/1209).

If every reachable instance is unhealthy, the extension still redirects to the least-bad configured instance rather than X.

A daily CI check compares the seed list and permitted superset with the health service, flags healthy instances that still need host permission, and verifies that seed instances serve real Nitter markup.

### Maintaining a fork

Adding a new domain requires:

1. Add it to `SEED_INSTANCES` in `background.js`.
2. Add its host permission to `manifest.json`.
3. Bump the version.
4. Re-sign and publish a new `.xpi`.

Domains already in the permitted superset require no release to become active or inactive.

## Install

### Temporary development install

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json`.

Temporary installations are removed when Firefox restarts.

### Permanent install

Download the signed `.xpi` from the [latest release](https://github.com/deroverda/twitter-to-nitter/releases/latest), then install through:

**`about:addons` → gear icon → Install Add-on From File...**

Releases are privately signed, unlisted builds created with [`web-ext sign`](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) using a free Mozilla developer account.

## Permissions and why they are needed

* `webRequest` + `webRequestBlocking` - intercept X/Twitter navigation **before it is sent** and observe Nitter response status.
* X/Twitter host access, including `www.`, `mobile.`, and `m.` - required to intercept those requests.
* Host access to the permitted Nitter instances - required to redirect to them and inspect their responses.
* `status.d420.de/api/*` - fetches fleet health data. No other path on that domain is requested.
* `storage` - stores the cached ranking and locally observed failures.

The X permission is necessary because blocking a request requires host permission for the domain being blocked. Without it, X would still receive the request while the extension decided where to redirect.

**No `<all_urls>`.** The extension has access only to X/Twitter, the configured Nitter instances, and the health API.

## Privacy

**No telemetry, analytics, tracking, or backend operated by this project.**

* **X normally never receives the navigation.** Exceptions:

  * X-only paths listed above intentionally remain on X.
  * If a redirect loop is detected, interception is briefly disabled for that tab and the request can reach X.
  * `t.co` links are not intercepted, so Twitter's URL shortener sees the click before the resulting X navigation is redirected.
* **One Nitter instance receives each request at a time.** A failed instance may be followed sequentially by another permitted instance during the same navigation, never simultaneously and never outside the permitted superset.
* **The health service receives no browsing data.** The extension requests one fixed, parameter-free URL without cookies about every 15 minutes, identically for every user. It is never contacted as part of navigation.
* **No Nitter probing.** Instance-specific health comes only from pages the user actually loads.
* **Page checks are minimal.** The extension checks whether a loaded page resembles Nitter and, if so, whether Nitter's own error panel identifies a known instance failure. It does not read, store, or transmit searches, profiles, tweet content, or other page data. The check produces only a temporary pass/fail/unknown result for that navigation.
* Instance health and rankings remain local to the browser.

### Media privacy

Some Nitter instances do not proxy media. On those instances, images and video load directly from Twitter's CDN (`pbs.twimg.com`, `video.twimg.com`), so Twitter-owned infrastructure can see which profile/media was requested. Media proxying is controlled by the instance operator. Prefer a proxying instance or run your own if this matters.

## Known limitations

* Nitter's **Open in X** link is intercepted too. Use a private window or disable the extension to deliberately open X.
* The health service can only activate domains already permitted by `manifest.json`; new domains require a release.
* Non-proxying Nitter instances load media from Twitter's CDN.
* X-only paths such as `/home`, `/notifications`, `/messages`, `/settings`, `/explore`, `/compose`, `/intent`, `/share`, `/login`, `/logout`, `/account`, `/tos`, and `/privacy` remain on X.
* Pressing **Back** after a fallback can trigger the same fallback again because the browser reloads the page the extension switched away from.
* A human-verification challenge that never resolves is a dead end for that navigation. The extension will not redirect away from a challenge, because it cannot tell someone part-way through solving one from a challenge that is stuck. Opening the X link again picks a different instance, since the challenging one is briefly deprioritised.
* Failure phrases such as `"rate limit"`, `"no auth tokens"`, and `"too many requests"` are recognized only in English. Structural checks can still detect pages that do not resemble Nitter.

## No runtime dependencies

The extension ships only:

* `manifest.json`
* `background.js`
* `check-page.js`
* `terminal-failure.html`
* `terminal-failure.js`
* `popup.html`
* `popup.js`

There is no build step, framework, or bundled dependency.

`check-page.js` is a separate file because some pages' CSP blocks inline script injection. It runs only on actively tracked navigations.

`terminal-failure.html/js` is a packaged extension page used when every configured instance fails; Firefox's `tabs.update()` rejects `data:` URLs.

`popup.html/js` provides the toolbar popup for selecting a preferred instance.

The repository also contains a `test/` harness run with `node --test` (`npm test`). It has one dev-only dependency, `linkedom`, for parsing HTML fixtures. Tests are not part of the extension and are excluded from the `.xpi`.
