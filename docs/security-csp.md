# Browser connection policy

The production Content Security Policy allows outbound `connect-src` requests to the application
origin and to HTTPS origins. This broader connection rule is required because v1 lets a user choose
an OpenAI-compatible HTTPS endpoint in the browser; a fixed host allowlist would make that approved
BYOK feature unusable.

The exception applies only to browser connections such as `fetch`. Remote scripts, frames, fonts,
styles, objects, and base URLs remain disallowed. `script-src` stays restricted to the application
origin, and `frame-ancestors 'none'` prevents embedding. Inline styles remain enabled only because
Lightweight Charts positions its canvas at runtime; no remote stylesheet origin is permitted.

Custom endpoints can still receive the bounded report request the user explicitly initiates. The UI
must disclose that trust boundary, and no API key or AI payload may be routed through the project's
Vercel Functions.
