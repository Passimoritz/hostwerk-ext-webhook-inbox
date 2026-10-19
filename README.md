![Webhook inbox](banner.svg)

# Webhook inbox

An address for the webhooks of Stripe, GitHub, PayPal & co. – public through Hostwerk's tunnel if you like. Every call with headers and body, check signatures, forward to your project or replay.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

![Screenshot](docs/screenshot.png)

## What it does

- A local receiver (port of your choice) – public with one click through Hostwerk's tunnel, closed again by emergency mode
- Every call with method, path, headers and body; JSON shown readably
- Signature check for GitHub, Stripe and any HMAC header
- Forward each call to your project and see its answer – or replay a stored call later
- Answer of your choice (status, body) so the sender is happy

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`data/webhook-inbox` – settings and the last 200 calls. Removing the extension keeps them.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
