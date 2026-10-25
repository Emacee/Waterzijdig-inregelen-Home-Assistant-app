# Changelog

## 0.1.3
- Nieuwe projectinstelling **cv-temperatuur** (aanvoer van cv-ketel of warmtepomp, optioneel
  apart voor vloerverwarming). Metingen hebben dan alleen de retour nodig: ΔT =
  cv-temperatuur − retour. De beoogde retour (cv-temperatuur − doel-ΔT) staat in de
  instellingen en in het overzicht. Een bij het element gemeten aanvoer gaat voor.
- Een leeggemaakte projectinstelling valt terug op de standaardwaarde.

## 0.1.2
- Beveiliging: alleen bereikbaar via de ingress-proxy van Home Assistant (andere containers
  worden geweigerd; X-Forwarded-For wordt niet meer vertrouwd).
- Beveiliging: pdf.js meegeleverd in plaats van via cdnjs geladen, en PDF's verwerkt met
  `isEvalSupported: false` (CVE-2024-4367). PDF-upload werkt daardoor ook zonder internet.
- Beveiliging: Content-Security-Policy en andere beveiligingsheaders, geen `/docs` en
  `/openapi.json` meer, strengere invoercontrole (ventieltypes, tijdstempels,
  plattegrondnamen), te grote uploads geweigerd vóór het inlezen.
- CSV-export: bescherming tegen formule-injectie in Excel; bestandsnamen met niet-ASCII-tekens
  geven geen fout meer.
- Sneller herberekenen en tekenen bij veel elementen (opzoeken per id in plaats van zoeken in
  de hele lijst).

## 0.1.1
- Verhuisd naar een eigen repository:
  https://github.com/Emacee/Waterzijdig-inregelen-Home-Assistant-app-
  (voorheen onderdeel van Emacee/ha-app). Geen functionele wijzigingen.

## 0.1.0
- Eerste versie: projecten, plattegronden (PNG/JPG/WebP, PDF via pdf.js in de browser),
  radiatoren/vloerverwarming/convectoren slepen op de plattegrond, metingen per element of
  als meetronde, advies verder open/dicht met nieuwe voorinstelling, meethistorie en
  CSV-export.
- Rekenmethode gelijk ΔT of op warmtevraag (EN 442-karakteristiek), per groep
  (radiatoren / vloerverwarming) met pompadvies; totaal pompdebiet blijft gelijk bij het
  verdelen.
- Icoon en logo voor de add-on store en de web-UI.
