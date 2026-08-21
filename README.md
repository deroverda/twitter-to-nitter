<div align="center">

<img src="logo.png" width="512" alt="Twitter/X to Nitter">

</div>

# Twitter/X to Nitter

A tiny Firefox extension that automatically redirects `x.com` and `twitter.com` links to a working Nitter frontend.

Unlike simple redirectors that point to a single hardcoded instance, this extension tests the destination page before considering the redirect successful, and automatically falls back to the next instance if the first one is rate-limited, broken, or returns an error.

## What it does

```
x.com/elonmusk
      ↓
tries a Nitter instance
      ↓
is it rate-limited / broken / a bad HTTP status?
      ↓ yes                          ↓ no
try the next instance          done - stay here
```

- Preserves the original path, query string, and hash
- Detects rate-limited instances
- Detects empty/broken search results
- Detects non-2xx HTTP responses (e.g. a bare 404 page)
- Remembers the last working instance so future redirects skip straight to it

## Instances

Configured in `background.js`:

- nitter.net
- nitter.poast.org
- nitter.privacyredirect.com
- xcancel.com
- lightbrd.com
- nitter.space
- nitter.tiekoetter.com
- nitter.catsarch.com

Public Nitter instances go offline or change behavior over time. If one stops working, check the [releases page](https://github.com/deroverda/twitter-to-nitter/releases/latest) for an updated build, or maintain your own fork.

If you're maintaining a fork: editing `NITTER_INSTANCES` in `background.js` and the matching host entry in `manifest.json` only takes effect for regular users after you bump the version, re-sign with `web-ext sign --channel=unlisted`, and publish a new `.xpi`. Editing the files directly only applies immediately if you're running the extension unpacked via `about:debugging` → "Load Temporary Add-on".

## Install

### Temporary (development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from this folder

This is wiped on every Firefox restart.

### Permanent

Download the signed `.xpi` from the [latest release](https://github.com/deroverda/twitter-to-nitter/releases/latest), then install it through `about:addons` → gear icon → "Install Add-on From File...".

This is a privately signed "unlisted" build made via [`web-ext sign`](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) with a free Mozilla developer account. It is never listed publicly on AMO. To build/sign your own copy instead of using the release, run `web-ext sign --channel=unlisted` against this repo with your own Mozilla API credentials.

## Why minimal permissions

Most Twitter/X redirector extensions request broad access (`<all_urls>`, every website) even though they only ever touch two domains. This extension requests only what it actually needs:

- `webNavigation` / `tabs` - to detect and redirect X/Twitter navigation
- `webRequest` - to check the HTTP status of the Nitter page it lands on
- `storage` - to remember the last working instance
- Host access to each configured Nitter instance only - needed to inspect the page content for rate-limit/empty-result detection

No host permission for `x.com`/`twitter.com` at all - redirecting away from a page doesn't require it. No `<all_urls>`. No access to any site you're not already choosing to visit.

## Privacy

No telemetry, analytics, tracking, remote configuration, or backend. The only network traffic is your browser talking directly to X/Twitter (before redirecting away) and the Nitter instance you land on.

## No dependencies

Just `manifest.json` and `background.js`. No build step, no npm packages, no framework.
