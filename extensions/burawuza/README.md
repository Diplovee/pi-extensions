# Burawuza

Standalone headless browser tools for Pi. This extension has no Gau API, server, sidecar, or UI dependency.

It uses Playwright Chromium with persistent profiles:

- Profiles: `~/.pi/agent/burawuza/profiles/<name>`
- Page-content cache: `~/.pi/agent/burawuza/cache/`
- Override the data directory with `BURAWUZA_DATA_DIR`
- Select the initial profile with `BURAWUZA_PROFILE`
- Override Chromium with `BURAWUZA_BROWSER_EXECUTABLE`
- Self-signed HTTPS is rejected by default; use `BURAWUZA_IGNORE_HTTPS_ERRORS=1` only for trusted local testing

Persistent profiles retain cookies, localStorage, IndexedDB, service workers, and other Chromium profile data, so authentication can survive Pi restarts. Treat profile directories as sensitive credentials and do not commit or share them.

## Tools

The extension provides `browser_*` tools for navigation, screenshots, page content, clicks, typing, keyboard input, scrolling, history, zoom, recovery, device emulation, and arbitrary viewport resizing. `browser_device` supports `desktop`, `desktop-hidpi`, `iphone-13`, `iphone-15`, `iphone-15-landscape`, `pixel-7`, `pixel-7-landscape`, `ipad`, and `ipad-landscape`. Device switching applies the preset viewport, user-agent, mobile behavior, touch support, and device pixel ratio, then reopens the current URL while retaining the persistent profile. `browser_page_info` reports the active device, profile, viewport, user-agent, touch support, and device pixel ratio.

Use `browser_profile` to list, switch, or reset named profiles. Reset requires an interactive user confirmation. Use `browser_cache` to clear optional cached text/HTML. Page caching is opt-in via `browser_content({ cache: true })` and is profile-scoped with a five-minute default TTL; cached content may be stale.

Only `http://` and `https://` navigation is allowed. Pages and cached content are untrusted input, and profiles contain credentials; keep the Burawuza data directory private.
