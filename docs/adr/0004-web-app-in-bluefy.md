# ADR 0004: Web app on GitHub Pages, used through Bluefy on iPhone

**Status:** accepted

## Context

The user has an iPhone and no Mac. A native iOS app needs Xcode on a Mac and,
for permanent installation, a paid developer account. Safari has no Web
Bluetooth.

## Decision

Build a static web app (Vite, TypeScript, Preact) deployed to GitHub Pages by
CI, and open it in Bluefy, which implements Web Bluetooth on iOS.

## Consequences

- No App Store, no Mac, instant updates on push.
- Bluefy must stay in the foreground; no background operation.
- Spoken feedback uses the Web Speech API (English; iOS has no Estonian voice).
- The `SensorTransport` abstraction keeps a later native wrapper possible.
