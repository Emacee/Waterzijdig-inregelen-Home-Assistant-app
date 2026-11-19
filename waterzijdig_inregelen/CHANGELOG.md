# Changelog

## 0.3.0
- Nieuw tabblad **Warmteverlies**: ruimtes uit de warmteverliesberekening met
  ontwerptemperatuur en warmteverlies. Upload de berekening als CSV, Excel (.xlsx) of PDF
  (tekst-PDF); de app herkent de ruimtes, koppelt ze op naam aan de ruimtes van de
  elementen en laat je alles controleren voordat het wordt opgeslagen.
- Per element een **ontwerpretour** en **ontwerpdebiet**: de retourtemperatuur waarbij het
  element bij de ontwerp-aanvoer precies zijn deel van het warmteverlies afgeeft bij de
  ontwerptemperatuur van zijn eigen ruimte. Meerdere elementen in één ruimte delen het
  warmteverlies naar vermogen.
- Inregelen **op ontwerpdebiet**: als de berekening voor alle gemeten elementen compleet is,
  is het advies ontwerpdebiet / huidig debiet. De doelretour in de meetronde schuift mee met
  de gemeten aanvoer- en ruimtetemperatuur.
- Nieuwe projectinstellingen *ontwerp-aanvoer radiatoren* en *vloerverwarming* (leeg = de
  cv-temperatuur).
- Een niet gemeten ruimtetemperatuur valt terug op de ontwerptemperatuur van de ruimte.
- Meetronde met kolom **Doelretour**; CSV-export met ontwerptemperatuur, aandeel
  warmteverlies, ontwerpretour en ontwerpdebiet.
- **Excel-sjabloon** voor de warmteverliesberekening met de ruimtes van het project; ingevuld
  weer te uploaden.
- Nieuw tabblad **Stooklijn**:
  - gasverbruik plakken uit Excel (meterstanden, verbruik per maand of van–tot-perioden);
  - graaddagen automatisch ophalen bij het KNMI (21 stations) of zelf invullen;
  - fit van verbruik tegen graaddagen: gas voor warm water en koken, gas per graaddag,
    warmteverliescoëfficiënt H en de warmtebehoefte bij de ontwerp-buitentemperatuur,
    vergeleken met de warmteverliesberekening;
  - benodigde aanvoertemperatuur per buitentemperatuur voor radiatoren en
    vloerverwarming, met de rechte stooklijn (eindpunt, voetpunt, helling) die nergens te
    laag is en de ruimtes die de stooklijn bepalen;
  - met één klik het ontwerppunt overnemen als ontwerp-aanvoer, met het warmteverlies
    geschaald naar het werkelijke gasverbruik.

## 0.2.1
- Meetronde: aanvoer en retour **bij de warmtebron** in te vullen; bij een cv-ketel volgt
  een waarschuwing als het ΔT daar boven de 20 K komt (kans op storing). Staat ook in het
  overzicht en de CSV-export.
- Hint om het doel-ΔT op 15 K te zetten als de radiatoren gemiddeld minder dan ~60 °C
  aanvoer krijgen terwijl het doel-ΔT 18 K of meer is.

## 0.2.0
- Leidingverloop intekenen op de plattegronden (aftakkingen snappen op bestaande leidingen).
- Nieuw tabblad **Schema**: hydraulisch schema op basis van plattegronden en leidingverloop,
  met verdiepingen, aftakkingen, vloerverwarmingsverdeler en het advies per element.
- Componenten toe te voegen aan het schema: secundaire pomp, boilervat, buffervat,
  thermostaat en mengklep. Schema te downloaden als SVG.

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
