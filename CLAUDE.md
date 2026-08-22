# twitter-to-nitter

Tiny private Firefox extension: redirects x.com/twitter.com to a working Nitter frontend, with automatic fallback. Two files only — `manifest.json`, `background.js`. No framework, no build system, no npm, no backend. Keep it that way — don't add a popup, options UI, or dependencies unless testing proves it's necessary.

See `HANDOFF.md` for current status, what's been tried, and what's next.

## Commands

```powershell
npx web-ext lint              # lint before every commit — also runs in CI on push
npx web-ext sign --channel=unlisted   # sign a private .xpi (needs free AMO dev account, API key/secret)
```

No install step — no dependencies to fetch.

## Release process

1. Bump `version` in `manifest.json`.
2. Tag and push (`git tag vX.Y.Z && git push --tags`) — do not push without being asked (see global CLAUDE.md section 0).
3. Create a GitHub release with the built `.xpi` as an asset.

## Gotchas

- **Nitter instance list lives in three unsynced places**: `NITTER_INSTANCES` in `background.js`, the `permissions` array in `manifest.json`, and the hardcoded instance string in `.github/workflows/instance-check.yml`. Adding/removing an instance means updating all three by hand.
- **`instance-check.yml`'s "down" results can be false positives** — GitHub Actions' datacenter IPs get bot-blocked by some Nitter instances regardless of User-Agent. Verify manually in a real browser before treating a flagged instance as actually dead.
- **Don't trust `web-ext lint`'s exit code alone** — it's 0 even when there are warnings, only real errors fail it. The CI workflow greps the actual error/warning counts from its output instead.
- **No host permission needed for x.com/twitter.com** — `tabs.update()` doesn't require destination host permission. Host permissions are only needed for the Nitter origins (DOM inspection via `executeScript`, and `webRequest` status checks).
