# Changelog

## 0.3.0
- Leidingverloop intekenen op de plattegronden (aftakkingen snappen op bestaande leidingen).
- Nieuw tabblad **Schema**: hydraulisch schema op basis van plattegronden en leidingverloop,
  met verdiepingen, aftakkingen, vloerverwarmingsverdeler en het advies per element.
- Componenten toe te voegen aan het schema: secundaire pomp, boilervat, buffervat,
  thermostaat en mengklep. Schema te downloaden als SVG.

## 0.2.0
- Nieuwe projectinstelling **cv-aanvoertemperatuur** (plus optioneel een eigen
  aanvoertemperatuur voor vloerverwarming). Metingen zonder aanvoer rekenen het ΔT vanaf
  deze temperatuur, zodat per element alleen de retour gemeten hoeft te worden.

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
