# MushMap

A mushroom foraging journal and heat map for Washington and Oregon, hosted on GitHub Pages at
<https://mendus59.github.io/mushmap/>.

- **Journal.** Upload photos of a find; the time and GPS location are read from the photo's EXIF data.
  Pick a tracked species or group (searching "morels" lists every *Morchella*), or enter your own name.
  Add notes on cluster size, trees and plants nearby, substrate and habitat. Search finds by date range,
  species or group, text, map area or distance, as a list or on a map.
- **Heat map.** A weekly likelihood map per species or group over Washington and Oregon. Version 1 uses the
  weeks and elevations of research-grade iNaturalist sightings and how close past sightings are; host trees and
  weather come next.

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
   state boundaries and samples each cell's elevation from AWS Terrain Tiles.
2. Fetches new research-grade, unobscured iNaturalist sightings for each group's `inatTaxa` and looks up
   their elevations.
3. Writes a model per group, and per species with at least 25 sightings: a smoothed week-by-elevation table
   and a past-sightings density per cell.
4. Force-pushes the results as a single commit to the `data` branch and redeploys the site, which copies
   `cells.json` and `model/` into `data/generated/`. The browser combines them for the chosen week
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
