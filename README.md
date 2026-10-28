# MushMap

A mushroom foraging journal and heat map for Washington and Oregon, hosted on GitHub Pages at
<https://mendus59.github.io/mushmap/>.

- **Journal.** Upload photos of a find; the time and GPS location are read from the photo's EXIF data.
  Pick a tracked species or group (searching "morels" lists every *Morchella*), or enter your own name.
  Add notes on cluster size, trees and plants nearby, substrate and habitat. Search finds by date range,
  species or group, text, map area or distance, as a list or on a map.
- **Heat map.** A weekly likelihood map per species or group over Washington and Oregon. It uses the
  weeks and elevations of research-grade iNaturalist sightings, how close past sightings are, how much of
  each mushroom's host trees grow in the cell, and, for the coming weeks, how this year's recent rain and
  temperature compare with the weather before past finds.

## Stack

| Part | Choice |
| --- | --- |
| Site | Vite + TypeScript, no framework, deployed to GitHub Pages by `.github/workflows/deploy.yml` |
| Accounts and data | Firebase Authentication (Google, email) and Cloud Firestore on the free Spark plan |
| Photos | Compressed in the browser to about 150 KB WebP and stored in Firestore (`users/{uid}/finds/{id}/photos/{n}`) |
| Maps | MapLibre GL with OpenFreeMap tiles (free, no key) |
| Elevation | Open-Meteo elevation API for single finds; AWS Terrain Tiles for the heat map grid (both free, no key) |

## Firebase setup

1. Create a Firebase project (Spark plan is fine).
2. **Authentication → Sign-in method:** enable Google and Email/Password.
3. **Authentication → Settings → Authorized domains:** add `mendus59.github.io`.
4. **Firestore Database:** create a database, then paste the contents of `firestore.rules` into the Rules tab
   and publish (or run `firebase deploy --only firestore:rules` with the Firebase CLI).
5. **Project settings → Your apps:** add a web app and paste its config object into `src/firebase-config.ts`.
   These values are public identifiers, not secrets.

## Heat map data

`pipeline/` (Python) builds the data and `.github/workflows/data.yml` runs it every Monday, or on demand from
the Actions tab:

1. On first run, builds an H3 resolution 7 grid (about 5 km² cells) over Washington and Oregon from Census
   state boundaries and samples each cell's elevation from AWS Terrain Tiles. Also once, builds `hosts.json`:
   live basal area per cell for every tree in a group's `hostTrees`, from the USDA Forest Service 250 m tree
   species maps (Wilson et al. 2013, RDS-2013-0013; about 3 GB of downloads, deleted after use).
2. Fetches new research-grade, unobscured iNaturalist sightings for each group's `inatTaxa` and looks up
   their elevations.
3. Writes a model per group, and per species with at least 25 sightings: a smoothed week-by-elevation table,
   a past-sightings density per cell and a host-tree score per cell. `hostFloor` sets how much a cell with
   none of the host trees still counts (1 means no host gate, as for wood-chip Psilocybe).
   Each model also gets a weather table from NOAA GHCN-Daily station records (free on AWS, about 3 GB of
   yearly files since 2008, reloaded each run): 14-day rain and 7-day mean temperature before each
   sighting, compared with the same place and date in every other year. `weather/current.json` holds the
   latest 14-day rain and 7-day temperature per cell; the browser applies it to the measured week and the
   two after.
4. Force-pushes the results as a single commit to the `data` branch and redeploys the site, which copies
   `cells.json`, `model/` and `weather/` into `data/generated/`. The browser combines them for the chosen week
   (`src/heatmapModel.ts`).

Run it locally with `pip install -r pipeline/requirements.txt && python pipeline/run.py --data generated`.

## Development

```sh
npm install
npm run dev      # http://localhost:5173/mushmap/
npm test
npm run build
```

Species and the host-tree list live in `public/data/species.json`.
