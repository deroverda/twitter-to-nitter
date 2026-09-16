"use strict";

function domainOf(origin) {
    return new URL(origin).hostname;
}

async function render() {
    const statusEl = document.getElementById("status");
    const actionEl = document.getElementById("action");

    const { currentOrigin, preferredInstance } = await browser.runtime.sendMessage({ type: "getPopupState" });

    if (currentOrigin && currentOrigin === preferredInstance) {
        statusEl.textContent = `Preferring ${domainOf(currentOrigin)}.`;
        actionEl.textContent = "Stop preferring this instance";
        actionEl.onclick = async () => {
            await browser.runtime.sendMessage({ type: "clearPreferred" });
            render();
        };
    } else if (currentOrigin) {
        statusEl.textContent = preferredInstance
            ? `You're on ${domainOf(currentOrigin)}. Currently preferring ${domainOf(preferredInstance)}.`
            : `You're on ${domainOf(currentOrigin)}. No preference set.`;
        actionEl.textContent = "Keep using this instance";
        actionEl.onclick = async () => {
            await browser.runtime.sendMessage({ type: "setPreferred", origin: currentOrigin });
            render();
        };
    } else if (preferredInstance) {
        statusEl.textContent = `Preferring ${domainOf(preferredInstance)}.`;
        actionEl.textContent = "Clear preference";
        actionEl.onclick = async () => {
            await browser.runtime.sendMessage({ type: "clearPreferred" });
            render();
        };
    } else {
        statusEl.textContent = "No preferred instance set. Open a Nitter page to set one.";
        actionEl.textContent = "Keep using this instance";
        actionEl.onclick = null;
    }

    // A preference only ever wins while the instance is still healthy (see
    // pickInitialInstance in background.js); it can silently stop applying
    // without the popup itself knowing, so nothing here claims it's guaranteed
    // to be honored on the next redirect.
    actionEl.disabled = !actionEl.onclick;
}

render();
