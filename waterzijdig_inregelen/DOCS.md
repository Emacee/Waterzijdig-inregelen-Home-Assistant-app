# Waterzijdig Inregelen — documentatie

## Werkwijze

1. **Nieuw project** → kies de warmtebron. Die bepaalt het standaard doel-ΔT voor de
   radiatoren: cv-ketel 20 K, warmtepomp 5 K. Vloerverwarming heeft een eigen doel-ΔT
   (standaard 5 K). Alles is aan te passen onder ⚙.
   Stel daar eventueel ook de **cv-aanvoertemperatuur** in (en, bij een gemengde groep,
   een eigen aanvoertemperatuur voor de vloerverwarming): metingen waarbij je de aanvoer
   leeg laat rekenen dan met die temperatuur, `ΔT = cv-aanvoer − retour`. Je hoeft per
   element dan alleen de retour te meten. Een wél ingevulde aanvoer gaat altijd voor.
2. **+ Plattegrond** → upload een of meer plattegronden (of sleep het bestand op de
   pagina). Dubbelklik op een tabblad om het te hernoemen of te verwijderen.
3. **Sleep** *Radiator*, *Vloerverwarming* of *Convector* uit de werkbalk op de
   plattegrond. Klik op een element om het te bewerken:
   * **Ventieltype** en **huidige stand** (voorinstelling, aantal slagen of l/min);
   * optioneel het **vermogen** (W, volgens typeplaatje bij 75/65/20, of voor
     vloerverwarming bij 35/30/20) en de **warmtevraag** van de ruimte (W).
4. Laat de installatie een tijd stabiel draaien (thermostaat hoog, thermostatische
   koppen vol open of eraf) en **meet** aanvoer en retour bij elk element, bijvoorbeeld
   met een klem- of infraroodthermometer. Voer de waarden in bij het element of in de
   **Meetronde**-tabel (Enter springt naar het volgende veld).
5. Pas de ventielen aan volgens het advies en klik **Stand … ingesteld** (of in de
   meetronde **Alle geadviseerde standen ingesteld**). Elementen waarvan de stand na de
   laatste meting is veranderd krijgen een gestippelde rand en *meten*: doe na een tijdje
   een nieuwe meetronde. Herhaal tot (bijna) alles groen is.

## Leidingverloop en hydraulisch schema

* **Leiding tekenen**: kies op de plattegrond **✎ Leiding** en klik de punten van het
  leidingverloop aan (Shift = haaks). Dubbelklik of Enter maakt de leiding af, Backspace
  haalt het laatste punt weg, Esc stopt. Een leiding staat voor het aanvoer/retour-paar
  en loopt vanaf het beginpunt (de stip).
* De eerste leiding op een plattegrond begint bij de aansluiting van die verdieping
  (stijgleiding of verdeler). Begin je een leiding óp een bestaande leiding (het punt
  snapt erop), dan is het een **aftakking**. Klik een leiding aan om haar een naam te
  geven, de richting om te draaien of haar te verwijderen.
* Het tabblad **Schema** tekent hieruit automatisch een hydraulisch schema: warmtebron
  links, per plattegrond een verdieping, elementen in de volgorde langs de leiding en
  elke aftakking als eigen tak. Een element hangt aan de dichtstbijzijnde leiding;
  ligt er geen leiding in de buurt, dan direct aan de verdieping (dat meldt het schema).
  Vloerverwarmingsgroepen komen per verdieping samen op een **verdeler**. Elk element
  toont zijn status-kleur en standadvies; klik erop om het op de plattegrond te openen.
* **Componenten** voeg je toe met de knoppen boven het schema:
  * **Secundaire pomp** en **mengklep** — op de hoofdleiding, een verdieping of de
    verdeler van de vloerverwarming;
  * **buffervat** en **boilervat** — bij de warmtebron (buffervat in de hoofdleiding,
    boilervat via een driewegklep);
  * **thermostaat** — regelt de warmtebron, een verdieping of de vloerverwarming
    (gestippelde regellijn).

  Het schema waarschuwt bij een buffervat zonder pomp op de hoofdleiding en bij een
  mengklep zonder eigen pomp. Met **SVG** download je het schema.

## Rekenmethode

Het afgegeven vermogen volgt de EN 442-karakteristiek
`Q = P_nom · (LMTD / LMTD_nom)^n` (n = 1,3 voor radiatoren, 1,1 voor vloerverwarming)
en het debiet `debiet [l/h] = Q / (1,163 · ΔT)`. Per element wordt een **doeldebiet**
bepaald; de verhouding *doel / huidig* is de **debietfactor** (> 1 = verder open).

* **Gelijk ΔT** (standaard): elk element moet bij zijn eigen aanvoertemperatuur het
  doel-ΔT halen. Het vermogen is hiervoor niet nodig; het wordt alleen gebruikt om
  elementen naar hun debiet te wegen (zonder vermogen telt een element als het
  gemiddelde).
* **Op warmtevraag**: als bij **alle** gemeten elementen van een groep zowel vermogen als
  warmtevraag is ingevuld, wordt het totaal geleverde vermogen verdeeld naar rato van de
  warmtevraag. Kan een element zijn deel bij deze aanvoertemperatuur niet leveren, dan
  luidt het advies "volledig open".
* **Pompdebiet gelijk houden** (standaard aan): dichtdraaien van het ene ventiel geeft
  de andere meer water. Daarom worden de doeldebieten binnen een groep zo geschaald dat
  het totale debiet gelijk blijft. Wat er dan nog afwijkt van het doel-ΔT verschijnt als
  **pompadvies** (pomp hoger of lager). Met één gemeten element in een groep wordt niet
  geschaald.
* **Groepen**: radiatoren/convectoren en vloerverwarming worden als aparte circuits
  ingeregeld, elk met een eigen doel-ΔT en pompadvies.
* **Nieuwe stand**: bij een ongeveer gelijk drukverschil over het ventiel is het debiet
  evenredig met de kv-waarde, dus `kv_nieuw = kv_huidig · factor`, terugvertaald naar een
  stand via de kv-tabel van het ventieltype en afgerond op de stapgrootte.
* "Goed" betekent: binnen de tolerantie (standaard ±10 % debiet) of minder dan één stap
  van het ventiel.

### Ventieltypes

Meegeleverd (indicatieve kv-waarden, per project aan te passen onder ⚙ → *Ventieltypes*):
Danfoss RA-N (1–7, N), Heimeier V-exact II (1–6, N), retourkoppeling/voetventiel in
slagen, verdeler met debietmeter (l/min, de stand ís het debiet) en generiek 0–100 %.
Alleen de verhouding tussen de standen telt. Een stap noteer je als `stand=kv`, met
optioneel een label: `8=0.56:N`.

## Beperkingen

* De berekening gaat uit van een stabiele toestand en een ongeveer constant drukverschil
  over de ventielen; inregelen blijft daardoor een paar rondes meten en bijstellen.
* De kv-tabellen zijn indicatief. Gebruik voor een nauwkeurig resultaat de waarden uit
  het datablad van je ventiel.
* PDF-plattegronden worden in de browser omgezet met pdf.js van cdnjs.cloudflare.com; dat
  vereist internet op het apparaat waarmee je uploadt. Zonder internet: exporteer de PDF
  eerst als PNG of JPG.

## Opties

| optie | standaard | betekenis |
|---|---|---|
| `log_level` | `info` | Hoeveel de add-on logt. |
| `max_upload_mb` | `25` | Maximale grootte van een plattegrond. |
