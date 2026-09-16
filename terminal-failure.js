"use strict";

const path = new URL(location.href).searchParams.get("path") || "/";
const safePath = path.startsWith("/") ? path : `/${path}`;

document.getElementById("retry").href = `https://x.com${safePath}`;
