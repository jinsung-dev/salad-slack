# Phase 0: Slack Desktop shell analysis

Static, read-only analysis of the installed Slack Desktop app with
[REA](https://github.com/morluto/rea) to learn how a production chat client
divides work between its desktop shell and its web client. Only structure and
behavior are recorded here; no Slack code, assets or branding is reused.

## Target

| Field | Value |
| --- | --- |
| App | `/Applications/Slack.app` 4.52.182 (macOS, arm64) |
| Analyzed archive | `Contents/Resources/app-arm64.asar` |
| SHA-256 | `49c1325a071e2c6441fec0a69917437a876526e5b7122b563a02dc2ce72d16cf` |
| Date | 2026-10-22 |

## Method

```bash
rea analyze-javascript-application /Applications/Slack.app/Contents/Resources/app-arm64.asar \
  --integrity-policy record-and-continue --json > app-graph.json
rea extract-artifact /Applications/Slack.app/Contents/Resources/app-arm64.asar \
  --integrity-policy record-and-continue --format json
```

`record-and-continue` was required: 8 unpacked native addons differ from the
digests declared in the ASAR header (observed for `keymapping.node`), which is
consistent with code signing after packaging. Those bytes are recorded as
untrusted. Cost: 144 s wall, 158 s CPU, 1.2 GB peak memory, 159 MB JSON.

## Findings

Observed means read directly from archive bytes; inferred means derived from
static patterns in minified code.

1. **The UI is a remote web client.** (observed) `app.asar` (21 KB) only selects
   the architecture-specific archive. The main bundle loads `https://app.slack.com`
   into its windows; the shell itself ships only small local pages
   (settings, basic-auth prompt, net-log viewer, error page, notifications).
   → Building the web client first and wrapping it later matches the reference
   design.

2. **Shell bundles.** (observed) webpack output in `dist/`:
   `boot.bundle.cjs` (package `main`) → `main.bundle.cjs` (1.7 MB, main process),
   `preload.bundle.js` (main window), `component-preload-entry-point.bundle.js`,
   `child-preload-entry-point.bundle.js`. No source maps for app code.

3. **Bridge surface exposed to the web client.** (observed) `contextBridge.exposeInMainWorld`
   is called for `desktop`, `slackPlatform` (`isWayland`), `process`, and
   `__SENTRY_IPC__`. Preload configuration keys cover notifications (method,
   timeout, max items, failover, zoom), dock badge, downloads, spellchecker
   language and idle timeout. IPC channel names are computed, so REA reported
   them as dynamic rather than literal.

4. **Desktop responsibilities** (observed unless noted):
   - `slack://` deep links via `setAsDefaultProtocolClient("slack")`
   - custom privileged `app://` scheme for local pages
   - spellcheck dictionaries downloaded per session
   - native addons: macOS notification state, keyboard layout mapping,
     native auth, CoreFoundation prefs, file handler lookup, and Windows focus
     assist / registry (8 total)
   - storage use in shell code: localStorage, sessionStorage, IndexedDB (inferred)
   - crash/telemetry via Sentry IPC

5. **Not covered.** The web client at `app.slack.com` (data model, realtime
   protocol, client cache) was not analyzed. That needs a logged-in browser
   capture of an account you own (`rea capture-browser-scenario`,
   `rea analyze-web-bundle`) and is scheduled before Phase 2.

## Decisions for Chatter

- Web client first (Phase 1); Electron shell in Phase 3 owning only
  notifications, badge, deep links (`chatter://`), tray and spellcheck.
- Expose one narrow, typed bridge object from preload instead of several globals.
- Realtime socket owned by the web client, not the shell.
