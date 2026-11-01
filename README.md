# Twin Game — Eminönü–Sirkeci

A client-side, building-free driving study of a small part of Istanbul. Drive on approximately **8.7 km of connected OpenStreetMap roads** with **smoothed, game-engineered road grades derived from real Copernicus DSM**, a detailed procedural hatchback, asphalt material, chase camera and optional bird's-eye view. Broad source terrain slopes remain; road corridors are intentionally adjusted for playability. No map-provider requests, API keys, external images, AI-generated geography, or live Overpass dependency during gameplay.

## Run

Requires Node.js **22.12 or newer** and a browser with WebGL support. From this repository:

```powershell
npm ci
npm run dev
```

Open the exact localhost URL printed by Vite. Click **Sürüşe başla**, or press an arrow key. `↑` / `W` accelerates; `↓` / `S` brakes before reversing; `←` / `A` and `→` / `D` steer; Space brakes; `V` changes camera; `R` returns to the safe Ankara Caddesi start; `P` pauses. Multi-touch buttons appear on touch devices. Losing window focus or hiding the tab pauses driving and releases inputs.

```powershell
npm test
npm run build
npm run preview
```

The production site is in `dist`. Serve it over HTTP; opening `index.html` directly as a file will not work. All gameplay data and assets are included in that build. The default deployment is at a domain root; for a subdirectory build, run `npm run build -- --base=/your-prefix/`.

Browser integration checks (run after the production build):

```powershell
npm run test:browser
```

If Playwright reports that its Chromium executable is missing, run `npx playwright install chromium` once, then retry. The test starts its own bounded local preview on port 5174, verifies real key input, motion/reverse/steering, pause/reset/focus loss, engineered road contact, sources, dark mode/mobile layout, actual multi-touch driving, graphics-context loss handling, explicit missing-elevation failure and local-only requests, saves PNGs to `test-results`, and stops its own browser/server. It also reads actual WebGL pixels at projected lane-marking positions **8–50 m ahead**, checks visibility in both themes before driving over the paint, and checks the rendered vehicle axes, fine mesh and world-scaled texture. Movement checks wait for measured state changes rather than assuming a GPU-dependent frame rate. Set `SCREENSHOT_DIR` to redirect screenshots.

## Geographic data and licensing

Bundled source data are in `public/data`; **these data have their own licenses, separate from application code**. Exact URLs, download times, OSM base timestamp, query, raw-source SHA-256, GeoTIFF registration and extraction window are in [provenance.json](public/data/provenance.json). JSON files are explicitly checked out with LF endings through `.gitattributes`, preserving the raw-source checksum on Windows as well as Unix.

| Layer | Source | Rights and important limits |
| --- | --- | --- |
| Road centre-lines and tags | [OpenStreetMap](https://www.openstreetmap.org/copyright), public Overpass interpreter | © OpenStreetMap contributors, **ODbL 1.0**. The included source and road-derived database remain subject to ODbL, including attribution and applicable share-alike obligations. Not an official municipal road survey. |
| Elevation samples | [Copernicus GLO-30 Public AWS COG](https://registry.opendata.aws/copernicus-dem/), tile `Copernicus_DSM_COG_10_N41_00_E028_00_DEM` | [Copernicus WorldDEM-30 free public license and required notices](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM). **DSM, not bare-earth DTM**; approximately 30 m grid, EGM2008 orthometric metres, WGS84 horizontal coordinates. |

**Required original elevation notice:**

> © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved

**Required adapted-product notice (this crop, road engineering, interpolation and visualization):**

> produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved

Both providers are credited in the visible UI; the complete elevation notice is in **Veri ve sınırlar**. Preserve these notices and the provenance when redistributing.

The geographic selection is WGS84 longitude **28.9655–28.9825° E**, latitude **41.0095–41.0178° N**: approximately **1.43 × 0.92 km** around Eminönü–Sirkeci. Downloaded road ways may extend beyond the requested rectangle, so segments are geometrically clipped. The downloaded elevation raster includes a surrounding sample margin. No full 1° elevation tile is redistributed. The committed crop contains **66 × 34** unrounded float samples, not manually invented terrain.

OSM is a preparation-time snapshot dated in provenance. The AWS distribution is the **Copernicus DEM 2021 release**, mainly derived from **TanDEM-X acquisitions in 2011–2015**, with possible older gap-filling models. Download date is **not** measurement date. Official GLO-30 product specifications quote absolute vertical error <4 m (90% linear error) and horizontal error <6 m (90% circular error); these are product-level specifications, **not a claim that this urban road model achieves street-level accuracy**. Buildings, trees, infrastructure, mixed pixels and outdated measurements can distort road elevations. Negative water/coast samples are retained. Fine mesh interpolation does not add measured detail.

### Reproduce the bounded elevation crop

```powershell
npm run data
```

This explicitly contacts public sources during **preparation**, reads the saved OSM snapshot if available, and downloads only the relevant COG byte ranges to regenerate the elevation crop and provenance. To deliberately update the roads as well:

```powershell
npm run data -- --refresh-roads
```

Providers can fail or time out; failures are printed and a failed source acquisition exits with an error. A new download may change the OSM snapshot. Commit all three data files together after reviewing an update. No credentials are required for these public sources. The game refuses invalid/missing elevations or roads; it never substitutes a flat terrain and calls it measured.

## Geometry and driving model

**Coordinate transform.** The origin is `(28.974° E, 41.01365° N)`. Let `R = 6,371,008.8 m`, `rad = π/180`, and `lat0` be the origin latitude:

```text
x = (lon - lon0) × rad × R × cos(lat0 × rad)     (east)
z = -(lat - lat0) × rad × R                    (south)
y = source EGM2008 orthometric elevation        (up)
```

This is a small-area spherical equirectangular approximation, not survey-grade UTM or an exact WGS84 ellipsoidal tangent plane. Units are metres; vertical scale is **1:1**, not exaggerated. Local horizontal approximation error is below roughly a few metres at this extent; OSM and DSM source accuracy still dominate.

**Pixel registration.** The actual COG declares `RasterPixelIsPoint` and a tiepoint at `(28, 42)`. Therefore sample locations are `origin + index × resolution` — **no erroneous half-pixel shift**. The crop includes one sample beyond its rounded bounds. Its grid spacing is 1/3600° in both axes, approximately 23.3 m east–west and 30.9 m north–south here.

**Source terrain.** The original DSM is sampled with piecewise-linear interpolation using the northwest–southeast diagonal of each source cell. Raw OSM, elevation and provenance JSON files remain unchanged by runtime road engineering. Negative source samples are retained; the world is not globally flattened or vertically exaggerated.

**Road engineering.** Road centre-lines are subdivided to at most **4 m**, with one shared height node at every connected junction. A source-anchored graph smoother runs 100 passes (2% source height, 98% distance-weighted adjacent heights), suppressing short DSM bumps while retaining broad changes. Balanced graph-distance upper/lower envelopes then cap each engineered profile edge at **12%** longitudinal grade. This is a gameplay constraint, not a claim about surveyed Istanbul roads. Neighbouring profiles blend into a common surface, reducing crossfall; an **18 m smoothstep shoulder band** connects cut/fill back to unmodified source samples. The final blended surface can have residual crossfall, especially at junctions; the 12% bound is on profile edges, not every surface direction.

**Terrain/road contact.** The resulting source-derived surface uses cells no larger than **3 × 3 m**. Ground rendering, road mesh, paint geometry, vehicle height, and wheel-area pose share the exact same triangle interpolation. Road capsules are polygon-unioned, clipped to each fine terrain triangle and triangulated (including holes), 0.08 m above the ground. Road triangle horizontal edges are at most about **4.25 m**, not the previous approximately 39 m source-cell diagonal. Clipping is spatially tiled to avoid repeatedly intersecting the entire map. The ground mesh is indexed and uses smooth visual normals; collision remains exactly on its triangles. Contours show 10 m intervals of the displayed engineered/source-blended surface. Low-surface-height coloring is **not a mapped or surveyed coastline**. The minimap still uses the original DSM.

The current dataset regression measures RMS longitudinal road slope decreasing from **10.93% to 6.23%** (about **43%** reduction), and RMS crossfall from **12.62% to 1.69%** (about **87%** reduction). These compare sampled midpoints of eligible real road segments; they are not maximum-slope or survey-accuracy promises. Tests also check source samples outside the shoulder bands, broad terrain range, shared junction continuity, actual driven contact, and unchanged raw-source checksum. The HUD labels its altitude **Yol kotu*** and explains that it is engineered, not a measured street elevation. A 3 m mesh does **not** upgrade the approximately 30 m DSM's measurement resolution.

**Asphalt and markings.** Asphalt is an original deterministic procedural texture: metre-scale weathering, centimetre-scale aggregate, roughness and subtle bump detail, with a **4 m world-space repeat** and mipmaps/anisotropic filtering. No external texture rights or network access are needed. Lane paint follows the exact fine triangle surface 0.025 m above asphalt. The original forward-hidden paint was reproduced with the same camera and geometry: disabling only asphalt's negative polygon depth offset changed forward white-pixel count from 0 to 34. Asphalt had been depth-biased in front of un-biased paint. Paint now has its own stronger offset, later render order, depth testing retained and depth writes disabled; it is not drawn through hills or the car. Dash phase continues across short OSM node segments, and both light/dark themes use visible paint.

**Road selection.** Primary/secondary/tertiary and their links, residential, unclassified, living-street and service ways are eligible. Pedestrian/footway/steps/construction paths, explicitly private or prohibited motor access, bridges, tunnels and nonzero-layer ways are excluded. Only the largest connected in-bounds component is playable. Shared OSM nodes define graph connections; disconnected isolated roads are not teleported together. OSM-tagged widths or lane counts are used where available; otherwise class defaults apply. Widths are limited to 6.4–18 m; narrow roads are **intentionally widened for arcade driving**. This is not a traffic-access map: one-way directions, conditional/time-specific restrictions, turn restrictions, tram separation, signals and road closures are not enforced.

**Physics and vehicle.** TypeScript + Three.js, polygon-clipping and earcut. A deterministic **120 Hz ground-constrained arcade model** is simpler and more reliable here than a full rigid-body vehicle over coarse urban DSM. The approximately 3.8 × 1.8 m hatchback has an original lofted/bevelled body and cabin, angled windows, mirrors, bumper/grille, lights, fictional `TWIN 01` plate, alloy wheels, tire/arch details, clearcoat and a procedural contact shadow. Wheel spin uses the axle axis and front wheels visually steer with the existing controls.

The vehicle has a conservative **2.15 m radius** circular collision footprint, samples its perimeter against the road union and brakes/slides on road edges. Pitch is positive when the front axle rises; roll is positive when the right side rises. A quaternion built from an orthonormal surface tangent basis replaces mixed Euler tilt, fixing the reversed bank sign and keeping orientation correct after arbitrary yaw, including combined uphill/cross slopes. The starting/reset pose is sampled immediately, not left flat until the first driving tick. No gravity jumps, suspension, damage, independent wheel collisions or Rapier/WASM are claimed. Road-edge checks are approximate footprint collision, not precise car-body contact. Maximum forward speed is about 79 km/h; reverse about 25 km/h. Boundary stubs are dead ends; `R` is an explicit return to spawn, never an automatic jump across gaps.

The chase camera follows the car with damped motion and a terrain-height guard. Bird's-eye view is an alternate **3D camera**, not an AI-converted fixed screenshot.

## Why not the municipal viewer or isometric screenshot method?

The public [İBB City Map API developer documentation](https://sehirharitasiapi.ibb.gov.tr/developer/) requires an API key. During prior source research, direct municipal 3D elevation/scene requests returned **401 / “No Access To This Service!”**. The viewer having public JavaScript, or some datasets carrying an open-data license, does not grant access to every backend. This prototype neither extracts viewer tokens nor bypasses those controls.

[İBB describes municipal DTM/DSM and other surveying products](https://haritamudurlugu.ibb.istanbul/arazi-saha-calismalarimiz/), but no legitimately accessible documented small-area DTM download was established for this task. The coarser public Copernicus DSM is therefore disclosed and used instead.

[Isometric Istanbul's documentation](https://isometricistanbul.com/en/docs) describes a fixed-angle screenshot-to-2D-image workflow, not downloadable navigable terrain/road meshes. Its visual workflow is not used here; it cannot replace source elevation, road connectivity or free chase-camera driving. No Google imagery, watermark removal, screenshot-derived mesh, or AI image generation is involved.

## Prototype boundaries

No buildings, satellite/photographic map textures, traffic, missions, multiplayer, sound, navigation routing, or complete peninsula coverage. Procedural asphalt and vehicle materials are original app content, not imagery extraction. This is a runnable source-backed prototype, **not a digital-twin survey or navigation product**. Engineered road grades are deliberately not measured street elevations. Subsequent higher-resolution municipal DTM integration would require legitimate data access, explicit redistribution terms and road-grade validation before replacing the current source.
