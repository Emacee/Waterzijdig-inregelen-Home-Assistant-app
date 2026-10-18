<p align="center">
  <img src="logo.png" alt="Waterzijdig Inregelen" width="420">
</p>

<p align="center">
  Home Assistant-add-on voor het <strong>waterzijdig inregelen van je cv-installatie</strong>.
</p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FEmacee%2FWaterzijdig-inregelen-Home-Assistant-app-"><img src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg" alt="Voeg deze repository toe aan Home Assistant"></a>
</p>

---

Upload de plattegronden van je woning, sleep elke radiator, convector en
vloerverwarmingsgroep op zijn plek, voer de gemeten aanvoer- en retourtemperaturen in en
zie per element of het ventiel **verder open** of **verder dicht** moet — inclusief de
**nieuwe voorinstelling** voor je ventieltype. Bij elke nieuwe meting wordt alles opnieuw
berekend. De add-on draait volledig lokaal en opent via de Home Assistant-zijbalk
(ingress).

## Add-ons in deze repository

| Add-on | Slug | Versie | Beschrijving |
|---|---|---|---|
| [Waterzijdig Inregelen](waterzijdig_inregelen/README.md) | `waterzijdig_inregelen` | 0.1.1 | Plattegronden, radiatoren/vloerverwarming slepen, metingen en per element advies verder open/dicht met nieuwe voorinstelling |

## Functies

- **Projecten** per woning of installatie, met warmtebron (cv-ketel of warmtepomp) en een
  eigen doel-ΔT voor radiatoren en vloerverwarming.
- **Plattegronden** in PNG, JPG, GIF, WebP of PDF (één plattegrond per PDF-pagina).
- **Slepen en neerzetten** van radiatoren, convectoren en vloerverwarmingsgroepen; werkt
  met muis en touchscreen.
- **Metingen** per element of als **meetronde** voor alle elementen tegelijk, met
  volledige meethistorie.
- **Advies per element** met kleurcodering, debietfactor en nieuwe voorinstelling voor
  o.a. Danfoss RA-N, Heimeier V-exact II, retourkoppelingen (slagen) en verdelers met
  debietmeter (l/min). Eigen ventieltypes zijn toe te voegen.
- **Pompadvies** per groep, inregelen op gelijke ΔT of naar warmtevraag (EN 442).
- **Hydraulisch schema** — teken het leidingverloop op de plattegronden; het tabblad
  **Schema** tekent daaruit automatisch een tweepijpsschema met verdiepingen, aftakkingen,
  vloerverwarmingsverdeler en de adviezen per element. Voeg secundaire pompen, boiler- en
  buffervat, thermostaten en mengkleppen toe; te downloaden als SVG.
- **CSV-export**; alle gegevens staan in de add-on-data en gaan dus mee in elke
  Home Assistant-back-up.

Zie [DOCS.md](waterzijdig_inregelen/DOCS.md) voor de werkwijze, de rekenmethode en de
opties.

## Installatie

Vereist Home Assistant OS of Supervised (add-ons zijn niet beschikbaar in Home Assistant
Container/Core). Ondersteunde architecturen: `amd64` en `aarch64`.

1. Klik op de knop hierboven, of ga in Home Assistant naar **Instellingen → Add-ons →
   Add-on Store**, open het **⋮**-menu (rechtsboven) → **Repositories** en voeg toe:

   ```
   https://github.com/Emacee/Waterzijdig-inregelen-Home-Assistant-app-
   ```

2. Ververs de store (**⋮ → Controleren op updates**); de add-on verschijnt onder
   *Waterzijdig Inregelen*.
3. Open **Waterzijdig Inregelen**, klik **Installeren** en daarna **Starten**. De
   Supervisor bouwt de add-on bij de eerste installatie lokaal; dat duurt een paar minuten.
4. Zet **Weergeven in zijbalk** aan en open **Inregelen**.

**Privé repository?** De Supervisor heeft dan inloggegevens nodig om te klonen. Voeg de
repository toe als
`https://<github-gebruiker>:<token>@github.com/Emacee/Waterzijdig-inregelen-Home-Assistant-app-`,
met een fine-grained personal access token met alleen-lezen *Contents*-toegang tot deze
repository.

### Overstappen vanuit `Emacee/ha-app`

Deze add-on zat eerder in de repository `Emacee/ha-app` en is daar verwijderd. Home
Assistant ziet de versie uit deze repository als een andere add-on, met een eigen
dataopslag. Wie de oude versie al gebruikte:

1. Exporteer per project de gegevens die je wilt bewaren (CSV) of noteer ze.
2. Installeer de add-on uit deze repository en zet de projecten opnieuw op.
3. Verwijder daarna de oude add-on (en eventueel de repository `ha-app` als je die
   verder niet gebruikt).

## Ontwikkeling

```
waterzijdig_inregelen/   de add-on (config.yaml, Dockerfile, app/, tests/)
branding/                bronbestanden van icoon en logo (SVG) en de social preview
repository.yaml          metadata voor de Home Assistant add-on store
```

- Lokaal testen:

  ```bash
  pip install -r waterzijdig_inregelen/requirements.txt pytest httpx
  pytest waterzijdig_inregelen/tests
  ```

- Een update uitbrengen: pas de code aan, verhoog `version` in
  `waterzijdig_inregelen/config.yaml` en voeg een regel toe aan
  `waterzijdig_inregelen/CHANGELOG.md`. Home Assistant biedt de update aan bij de
  volgende verversing van de repository.
- GitHub Actions controleert elke push met de add-on-linter, draait de tests en bouwt
  het image voor `amd64` en `aarch64` (zonder te publiceren).
- `branding/social-preview.png` kun je instellen als social preview onder
  **Settings → General → Social preview** van de GitHub-repository.
