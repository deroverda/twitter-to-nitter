// Runs check-page.js (unmodified) against real HTML/XML fixtures.
//
// check-page.js is `(() => { ... })();` and evaluates to false ("leave this
// page alone"), "fail" (a confidently-identified instance failure), or
// "unknown" (doesn't look like Nitter's template at all, but not confidently
// a failure -- see check-page.js for why that distinction matters). It reads
// only `document` and the `HTMLElement` global, so we wrap the source in a
// Function that takes both.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { parseHTML, DOMParser } = require("linkedom");

// check-page.js ends with `})();` -- strip the trailing `;` so it can be
// wrapped in `return ( ... )`.
const SRC = readFileSync(path.join(__dirname, "..", "check-page.js"), "utf8")
    .trim()
    .replace(/;$/, "");
const runCheck = new Function("document", "HTMLElement", "return (" + SRC + ");");

function classifyHTML(file) {
    const html = readFileSync(path.join(__dirname, "fixtures", file), "utf8");
    const { document, HTMLElement } = parseHTML(html);
    return runCheck(document, HTMLElement);
}

function classifyXML(file) {
    const xml = readFileSync(path.join(__dirname, "fixtures", file), "utf8");
    const { HTMLElement } = parseHTML("<html></html>");
    const document = new DOMParser().parseFromString(xml, "text/xml");
    return runCheck(document, HTMLElement);
}

test("working profile is not a failure", () => {
    assert.equal(classifyHTML("working-profile.html"), false);
});

test("empty profile (no tweets) is not a failure", () => {
    assert.equal(classifyHTML("empty-profile.html"), false);
});

test("Nitter error panel naming a rate limit is a failure", () => {
    assert.equal(classifyHTML("error-panel-rate-limited.html"), "fail");
});

test("Nitter error panel wording 'rate limit exceeded' is also a failure", () => {
    assert.equal(classifyHTML("error-panel-rate-limit-exceeded.html"), "fail");
});

test("Nitter error panel for a missing user is not a failure", () => {
    assert.equal(classifyHTML("error-panel-not-found.html"), false);
});

test("fork rate-limit page without .error-panel is a failure", () => {
    assert.equal(classifyHTML("fork-rate-limit-no-panel.html"), "fail");
});

test("operator shutdown page (no Nitter markers) is an unknown-template failure, not a confirmed one", () => {
    assert.equal(classifyHTML("shutdown-page.html"), "unknown");
});

test("Cloudflare challenge page reports as a challenge, not a failure", () => {
    assert.equal(classifyHTML("cloudflare-challenge.html"), "challenge");
});

test("localized Cloudflare challenge is detected by fingerprint, not title", () => {
    assert.equal(classifyHTML("cloudflare-challenge-localized.html"), "challenge");
});

test("RSS feed is not judged by markup", () => {
    assert.equal(classifyXML("rss-feed.xml"), false);
});
