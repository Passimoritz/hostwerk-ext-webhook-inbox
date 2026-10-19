![Webhook-Postfach](banner.svg)

# Webhook-Postfach

Eine Adresse, an die Stripe, GitHub, PayPal & Co. ihre Webhooks schicken – auf Wunsch öffentlich über Hostwerks Tunnel. Jeder Aufruf mit Kopfzeilen und Inhalt, Signaturen prüfen, an dein Projekt weiterleiten oder erneut abspielen.

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public) Erweiterung (SDK 2.7, native Erweiterung)

![Screenshot](docs/screenshot.de.png)

## Was sie kann

- Ein Empfänger auf diesem PC (Port frei wählbar) – mit einem Klick öffentlich über Hostwerks Tunnel, der Notfall-Modus schließt ihn mit
- Jeder Aufruf mit Methode, Pfad, Kopfzeilen und Inhalt; JSON lesbar
- Signatur-Prüfung für GitHub, Stripe und beliebige HMAC-Kopfzeilen
- Jeden Aufruf an dein Projekt weiterleiten und dessen Antwort sehen – oder einen gespeicherten später erneut abspielen
- Antwort nach Wunsch (Status, Inhalt), damit der Absender zufrieden ist

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Deshalb installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

`data/webhook-inbox` – Einstellungen und die letzten 200 Aufrufe. Beim Entfernen der Erweiterung bleiben sie erhalten.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # dieselbe Prüfung wie der Katalog (sdk/check.js)
```

Oberfläche in `ui/src`, Server-Teil in `server/`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
