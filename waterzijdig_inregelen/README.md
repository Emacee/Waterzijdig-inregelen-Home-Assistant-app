# Waterzijdig Inregelen

Houd het **waterzijdig inregelen van je cv-installatie** bij, direct vanuit de Home
Assistant-zijbalk. Upload de plattegronden van je woning, sleep elke radiator en
vloerverwarmingsgroep op zijn plek, voer de gemeten aanvoer- en retourtemperaturen in en
zie per element of het ventiel **verder open** of **verder dicht** moet — inclusief de
nieuwe voorinstelling. Bij elke nieuwe meting wordt alles opnieuw berekend.

## Waarom inregelen?

Zonder inregelen krijgen de radiatoren dicht bij de ketel of warmtepomp te veel water en
die verderop te weinig. Gevolg: sommige kamers worden niet warm, de retourtemperatuur is
te hoog en een HR-ketel condenseert niet (of een warmtepomp draait met een slechtere
COP). Door elke radiator het juiste debiet te geven, krijgt elke ruimte de warmte die ze
nodig heeft bij een zo laag mogelijke aanvoertemperatuur.

## Functies

- **Projecten** — per woning of installatie, met warmtebron (cv-ketel of warmtepomp) en
  een eigen doel-ΔT voor radiatoren en vloerverwarming.
- **Plattegronden** — upload PNG, JPG, GIF, WebP of PDF (een PDF met meerdere
  pagina's wordt één plattegrond per verdieping/pagina).
- **Slepen en neerzetten** — zet radiatoren, convectoren en vloerverwarmingsgroepen op de
  plattegrond en verplaats ze wanneer je wilt; werkt met muis en touchscreen.
- **Metingen** — per element of als **meetronde** voor alle elementen tegelijk in één
  tabel. De volledige meethistorie wordt bewaard, met de ventielstand van dat moment.
- **Advies per element** — kleurcodering op de plattegrond (groen goed, oranje verder
  open, blauw verder dicht) met de debietfactor en de **nieuwe voorinstelling**, voor o.a.
  Danfoss RA-N, Heimeier V-exact II, retourkoppelingen (slagen) en verdelers met
  debietmeter (l/min). Eigen ventieltypes zijn toe te voegen.
- **Pompadvies** — wanneer het totale debiet te hoog of te laag is voor het doel-ΔT.
- **Optioneel vermogen en warmtevraag** — vul je bij alle radiatoren vermogen en
  warmtevraag in, dan wordt naar warmtevraag ingeregeld in plaats van op gelijke ΔT.
- **CSV-export** voor Excel, en alles staat in de add-on-data, dus in elke
  Home Assistant-back-up.

## Aan de slag

1. Start de add-on en open **Inregelen** in de zijbalk.
2. Maak een project aan en upload een plattegrond.
3. Sleep de radiatoren en vloerverwarming erop en vul per element het ventieltype en de
   huidige stand in.
4. Laat de installatie stabiel draaien en meet aanvoer en retour bij elk element (klem- of
   infraroodthermometer). Vul de waarden in onder **Meetronde**.
5. Stel de ventielen in volgens het advies, meet na een tijdje opnieuw en herhaal tot alles
   groen is.

Zie het tabblad **Documentatie** voor de rekenmethode en alle instellingen.
