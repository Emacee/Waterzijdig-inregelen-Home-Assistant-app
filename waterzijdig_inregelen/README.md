# Waterzijdig Inregelen (Home Assistant add-on)

Houd het waterzijdig inregelen van een cv-installatie bij, direct vanuit de Home
Assistant-zijbalk (ingress).

* **Projecten** met een of meer **plattegronden** (PNG, JPG, WebP of PDF; een PDF met
  meerdere pagina's wordt per pagina een plattegrond).
* **Sleep** radiatoren, vloerverwarmingsgroepen en convectoren op hun plek op de
  plattegrond en versleep ze later als dat nodig is.
* Voer per element de **aanvoer- en retourtemperatuur** in (per element of als
  **meetronde** in één tabel) en zie meteen per element: **verder open**, **verder
  dicht** of **goed**, plus de **nieuwe voorinstelling** van het ventiel.
* Na elke nieuwe meting wordt alles **herberekend**; de meethistorie blijft bewaard,
  inclusief de ventielstand waarbij gemeten is.
* Export naar **CSV** (Excel, met puntkomma's).

Alle gegevens staan in `/data` van de add-on en gaan dus mee in elke Home
Assistant-back-up. Zie [DOCS.md](DOCS.md) voor de rekenmethode en de werkwijze.
