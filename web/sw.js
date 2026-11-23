// Offline shell for the staff desk (T-016): caches static assets only.
// API responses are NEVER cached — stale attestation data must not be
// served as live; the desk shows the cached-view badge instead.
"use strict";
const CACHE = "kt-shell-v2";
const ASSETS = ["index.html", "public.html", "styles.css", "app.js", "drafts.js", "timeline.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(
      ks.filter((k) => k.startsWith("kt-shell-") && k !== CACHE).map((k) => caches.delete(k)))));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // never cache API data
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && e.request.method === "GET") {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() =>
      // Navigation requests ("/" etc.) fall back to the cached shell so a
      // cold reload offline still opens the desk with its IndexedDB drafts.
      caches.match(e.request).then((r) =>
        r || (e.request.mode === "navigate" ? caches.match("index.html") : undefined))));
});
