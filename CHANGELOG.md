## 1.4.0

- Lives where it belongs: Projects → Webhooks – no own sidebar entry any more (Hostwerk 3.0+); the full page stays under Extensions → Open and can be pinned in the sidebar settings. / Steckt jetzt dort, wo sie hingehört: Projekte → Webhooks – kein eigener Seitenleisten-Eintrag mehr (Hostwerk 3.0+); die ganze Seite bleibt unter Erweiterungen → Öffnen und lässt sich in den Seitenleisten-Einstellungen anheften.

## 1.3.0

- Security: the signature secret and the login headers of stored calls (Authorization, Cookie, API keys …) are sealed with Hostwerk's key and only shown masked; older data is sealed on the first start. / Signatur-Geheimnis und Anmelde-Kopfzeilen versiegelt.
- Forwarding answers the sender at once and forwards right after – GitHub and Stripe no longer see a timeout. Optional "Pass on your project's answer" keeps the old behaviour, now with the project's Content-Type. / Weiterleitung antwortet sofort; Content-Type bleibt erhalten.
- Several paths with their own answer, forwarding and signature check. / Mehrere Pfade mit eigener Antwort und Weiterleitung.
- Search and filter calls by event. / Suche und Filter nach Ereignis.
- More signatures: Shopify, Slack, Twilio, Discord. / Weitere Signaturen.
- Times in Hostwerk's language, sizes from the design scale, own place in the sidebar (Develop), other extensions may add tabs. / Zeiten in Hostwerks Sprache, Design-Skala, Seitenleiste.

## 1.2.0

- "Open in API tester": a received call becomes a request in the API tester (target: your forward address or the local receiver). Needs the API tester extension. / „Im API-Tester öffnen“: ein empfangener Aufruf wird zur Anfrage im API-Tester (Ziel: deine Weiterleitung bzw. der Empfänger auf diesem PC). Braucht die Erweiterung API-Tester.

## 1.1.0

- Fixed address: with your own domain (Live → Remote access) the inbox gets an address that never changes, unlike the tunnel address. Signatures stay valid (the body is passed on unchanged); a new address can be made at any time. / Feste Adresse: mit eigener Domain (Livebetrieb → Fernzugriff) bekommt das Postfach eine Adresse, die sich nie ändert – anders als die Tunnel-Adresse. Signaturen bleiben gültig (der Body kommt unverändert an); eine neue Adresse geht jederzeit.

## 1.0.0

- First release. / Erste Fassung.
