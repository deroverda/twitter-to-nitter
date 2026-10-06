// The README's seed list is hand-maintained prose, so it can drift from
// SEED_INSTANCES in background.js (it did once, with xcancel.com). This
// compares the two so a mismatch fails the test run instead of going public.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const read = (file) => readFileSync(path.join(__dirname, "..", file), "utf8");

function readmeSeedHosts() {
    const readme = read("README.md");
    const start = readme.indexOf("**Seed list**");
    const end = readme.indexOf("**Permitted superset**");

    assert.ok(start !== -1 && end > start, "README must keep its Seed list and Permitted superset headings");

    return [...readme.slice(start, end).matchAll(/^\* `([a-z0-9.-]+)`/gm)].map((m) => m[1]).sort();
}

function sourceSeedHosts() {
    const source = read("background.js");
    const start = source.indexOf("const SEED_INSTANCES = [");
    const end = source.indexOf("\n];", start);

    assert.ok(start !== -1 && end > start, "background.js must keep its SEED_INSTANCES array");

    const block = source
        .slice(start, end)
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");

    return [...block.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]).sort();
}

test("README's seed list matches SEED_INSTANCES in background.js", () => {
    const fromReadme = readmeSeedHosts();
    const fromSource = sourceSeedHosts();

    assert.ok(fromSource.length > 0, "parsed no seed instances from background.js");
    assert.deepEqual(fromReadme, fromSource);
});
