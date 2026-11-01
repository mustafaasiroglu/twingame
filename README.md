# Twin Game — Ihlamur Kasrı / Beşiktaş

A static client-side driving study around **Ihlamur Kasrı, Beşiktaş**, with **smoothed, game-engineered road grades derived from real Copernicus DSM**, a procedural hatchback, asphalt, chase/local bird's-eye cameras, OSM building footprints, green areas, pedestrian paths, trees and sidewalks. “The surrounding 5 km area” is interpreted as a **5 km radius**, not diameter: approximately **78.5 km²**, including water. The playable largest connected European-side motor-road network contains approximately **1,217 km** of source-derived roads. Broad terrain slopes remain; road corridors are adjusted for playability. Gameplay fetches only bundled local assets, never live geodata providers.

## Run

Requires Node.js **22.12 or newer** and a browser with WebGL support. From this repository:

```powershell
npm ci
npm run dev
```

Open the exact localhost URL printed by Vite. Click **Sürüşe başla**, or press an arrow key. `↑` / `W` accelerates; `↓` / `S` brakes before reversing; `←` / `A` and `→` / `D` steer; Space brakes; `V` changes camera; `R` returns to the safe named-road start near Ihlamur; `P` pauses. The current start is on Muradiye Bostanı Sokağı, approximately **142 m from the selected palace centre**, away from junctions/private palace driveways. Multi-touch buttons appear on touch devices. Losing window focus or hiding the tab pauses driving and releases inputs.

```powershell
npm test
npm run build
npm run preview
```

The production site is in `dist`. Serve it over HTTP; opening `index.html` directly as a file will not work. All gameplay data and assets are included in that build. The default deployment is at a domain root; for a subdirectory build, run `npm run build -- --base=/your-prefix/`.

Browser integration checks (run after the production build):

```powershell
npm run test:browser
npm run test:handling
```

If Playwright reports that its Chromium executable is missing, run `npx playwright install chromium` once, then retry. The test starts its own bounded local preview on port 5174, verifies both actual palace footprints and terrain-based/inferred height semantics, bounded source detail chunks, real key input, motion/reverse/steering, pause/reset/focus loss, engineered road contact, sources, dark/mobile rendering, multi-touch driving, graphics-context loss handling, explicit missing-elevation failure and local-only requests. It saves `ihlamur-chase.png`, `ihlamur-overview.png`, `ihlamur-dark.png` and `ihlamur-mobile.png`, then stops its own browser/server. Actual WebGL pixels at projected lane-marking positions **8–50 m ahead** are checked in both themes, along with rendered vehicle axes, fine mesh and world-scaled texture. Movement waits for measured state changes rather than assuming a GPU-dependent frame rate. Set `SCREENSHOT_DIR` to redirect screenshots.

The handling browser check starts a separate bounded preview on a free OS-assigned loopback port (or uses `HANDLING_URL` when provided), approaches a road edge using real arrow inputs, countersteers back parallel and requires acceleration without premature slowdown while staying road-grounded. It stops its own browser/server. Unit regressions compare centre/near-edge acceleration and coasting, yaw, reverse, actual/outside impacts, grazing contact, mixed-width junction tangents and real source-road contact. In an identical 120 Hz, 1 s, 6.4 m-road benchmark starting at 10 m/s, the previous version ended at **0.488 m/s** at a 1.9 m lateral offset despite its centre being on asphalt; the corrected version reaches **16.359 m/s**, exactly matching centre-line acceleration. Centre-line power/drag are unchanged; head-on collision slowdown is retained.

## Geographic data and licensing

Bundled source data are in `public/data`; **these data have their own licenses, separate from application code**. Exact place lookup, URLs, download time, bounded filter, source SHA-256, GeoTIFF registration and extraction windows are in [provenance.json](public/data/provenance.json). The publisher did not provide a verified OSM database-base timestamp: it is explicitly `null`, not an invented survey date. JSON files use LF through `.gitattributes`, preserving the source checksum on Windows and Unix.

| Layer | Source | Rights and important limits |
| --- | --- | --- |
| Roads, buildings/parts, landcover, paths, tree nodes/rows, sidewalk tags and water | [OpenStreetMap](https://www.openstreetmap.org/copyright), [public BBBike Istanbul PBF extract](https://download.bbbike.org/osm/bbbike/Istanbul/) | © OpenStreetMap contributors, **ODbL 1.0**. Included source and derived geographic databases remain subject to ODbL, including attribution and applicable share-alike obligations. Not a municipal survey. |
| Elevation samples | [Copernicus GLO-30 Public AWS COG](https://registry.opendata.aws/copernicus-dem/), tiles `Copernicus_DSM_COG_10_N41_00_E028_00_DEM` and `...E029_00_DEM` | [Copernicus WorldDEM-30 free public license and required notices](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM). **DSM, not bare-earth DTM**; approximately 30 m grid, EGM2008 orthometric metres, WGS84 horizontal coordinates. |

**Required original elevation notice:**

> © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved

**Required adapted-product notice (this crop, road engineering, interpolation and visualization):**

> produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved

Both providers are credited in the visible UI; the complete elevation notice is in **Veri ve sınırlar**. Preserve these notices and the provenance when redistributing.

The centre comes from the actual public Nominatim result for **OSM way 312484207, Ihlamur Kasrı (Merasim Köşkü)**: **29.0011982° E, 41.0507128° N**. The separate Maiyet Köşkü footprint is **way 312484208**. Bounding longitude is **28.941571741–29.060824659° E**, latitude **41.005746782–41.095678818° N**. Roads are analytically circle-clipped with half-width inset; polygon details are clipped to a 128-sided approximation of the 5 km circle. The actual two-tile DSM mosaic has **433 × 328 = 142,024 unrounded samples**, with a source margin around the region. No complete 1° elevation tile is redistributed.

OSM is a preparation-time snapshot dated in provenance. The AWS distribution is the **Copernicus DEM 2021 release**, mainly derived from **TanDEM-X acquisitions in 2011–2015**, with possible older gap-filling models. Download date is **not** measurement date. Official GLO-30 product specifications quote absolute vertical error <4 m (90% linear error) and horizontal error <6 m (90% circular error); these are product-level specifications, **not a claim that this urban road model achieves street-level accuracy**. Buildings, trees, infrastructure, mixed pixels and outdated measurements can distort road elevations. Negative water/coast samples are retained. Fine mesh interpolation does not add measured detail.

### Reproduce the bounded elevation crop

```powershell
npm run data
```

This contacts public sources only during **preparation**, reuses the persisted bounded OSM snapshot when present, downloads relevant COG byte ranges and derives all runtime assets. Public Overpass services failed with capacity/rate/timeouts during this preparation; the legitimately public BBBike extract was used instead, not an access-control workaround. To deliberately refresh the regional extract and bounded source:

```powershell
npm run data -- --refresh-roads
```

To regenerate derived assets without contacting geodata providers:

```powershell
npm run data:world
```

Preparation filters the regional PBF in multiple passes to retain relevant ways/relations and their complete referenced nodes, without contributor identity/contact metadata. The ignored `data-cache` holds the preparation-only regional PBF; the bounded, reproducible source remains committed as `osm-source.json` (~63.8 MB). Gameplay **does not parse this giant raw JSON**. It loads `roads.json` (connected physics network), `display-roads.json` (eligible disconnected surface roads too), `profiles.bin` (332,625 profile edges, Float64 little-endian, nine fields documented in `world.json`), elevation/provenance, and nearby `tiles/*.json`. All public data currently total approximately **164 MB**; initial roads/profiles and worker initialization are substantial, so this is a desktop-oriented prototype, not a tiny download.

Providers can fail/time out; acquisition exits with an explicit error. Regeneration can change the snapshot. Review and commit source, provenance, elevation, manifest and all derived assets together. No credentials are required. Invalid/missing source or worker/detail failures stop the game visibly; there is no fabricated flat fallback.

## Geometry and driving model

**Coordinate transform.** The origin is the resolved palace coordinate `(29.0011982° E, 41.0507128° N)`. Let `R = 6,371,008.8 m`, `rad = π/180`, and `lat0` be the origin latitude:

```text
x = (lon - lon0) × rad × R × cos(lat0 × rad)     (east)
z = -(lat - lat0) × rad × R                    (south)
y = source EGM2008 orthometric elevation        (up)
```

This is a local spherical equirectangular approximation, not survey-grade UTM or an exact WGS84 ellipsoidal tangent plane. Units are metres; vertical scale is **1:1**. Projection error grows with extent; no street-survey horizontal accuracy is claimed.

**Pixel registration.** Both COGs declare `RasterPixelIsPoint`, with tiepoints `(28, 42)` and `(29, 42)`. Samples are `origin + index × resolution` — **no half-pixel shift**. The mosaic uses one continuous 1/3600° lattice across longitude 29°, without duplicate/gapped seam columns: approximately 23.3 m east–west and 30.9 m north–south.

**Source terrain.** The original DSM is sampled with piecewise-linear interpolation using the northwest–southeast diagonal of each source cell. Raw OSM, elevation and provenance JSON files remain unchanged by runtime road engineering. Negative source samples are retained; the world is not globally flattened or vertically exaggerated.

**Road engineering.** Road centre-lines are subdivided to at most **4 m**, with one shared height node at every connected junction. A source-anchored graph smoother runs 100 passes (2% source height, 98% distance-weighted adjacent heights), suppressing short DSM bumps while retaining broad changes. Balanced graph-distance upper/lower envelopes then cap each engineered profile edge at **12%** longitudinal grade. This is a gameplay constraint, not a claim about surveyed Istanbul roads. Neighbouring profiles blend into a common surface, reducing crossfall; an **18 m smoothstep shoulder band** connects cut/fill back to unmodified source samples. The final blended surface can have residual crossfall, especially at junctions; the 12% bound is on profile edges, not every surface direction.

**Terrain/road contact and streaming.** Shared **3 × 3 m** cells are evaluated lazily, rather than allocating the whole 10 km-wide fine grid. Ground, asphalt, paint, vehicle height and pose use identical triangle interpolation. Road capsules are unioned/clipped to fine triangles, including holes, 0.08 m above ground; horizontal road triangle edges are at most approximately **4.25 m**. The world has 192 m chunks: **3×3 near-detail chunks**, plus the actual palace footprint tiles while nearby, and **11×11 total near/far terrain chunks**, updated as the car moves. Palace detail anchors prevent a pavilion from being partly cut off at the near/far LOD boundary. Far terrain uses a 24 m visual LOD; border fragments use finer samples to retain circular coverage. Buildings are batched per chunk and trees are instanced. A local **Web Worker** generates meshes and transfers buffers, so polygon construction does not synchronously freeze driving. Far LOD is a rendering approximation, not new measured accuracy. Low terrain color is not coastline data; the minimap uses the original DSM.

The Ihlamur dataset regression measures RMS longitudinal road slope decreasing from **14.116% to 8.318%** (about **41%** reduction), and RMS crossfall from **18.557% to 5.464%** (about **71%** reduction). These are sampled eligible real-road midpoints, not maximum-slope/survey-accuracy promises. Source samples outside shoulders, broad terrain range, junction continuity, driven contact and source checksum are tested. The HUD labels its altitude **Yol kotu***: engineered, not surveyed street elevation. A 3 m mesh does **not** improve DSM measurement resolution.

**Asphalt and markings.** Asphalt is an original deterministic procedural texture: metre-scale weathering, centimetre-scale aggregate, roughness and subtle bump detail, with a **4 m world-space repeat** and mipmaps/anisotropic filtering. No external texture rights or network access are needed. Lane paint follows the exact fine triangle surface 0.025 m above asphalt. The original forward-hidden paint was reproduced with the same camera and geometry: disabling only asphalt's negative polygon depth offset changed forward white-pixel count from 0 to 34. Asphalt had been depth-biased in front of un-biased paint. Paint now has its own stronger offset, later render order, depth testing retained and depth writes disabled; it is not drawn through hills or the car. Dash phase continues across short OSM node segments, and both light/dark themes use visible paint.

**Road selection.** Primary/secondary/tertiary and links, residential, unclassified, living-street and service ways are eligible. Private/prohibited motor access, bridges, tunnels and nonzero-layer ways are excluded; their unknown deck elevations are not fabricated. Footpaths are decoration, not driveable roads. Only the largest connected in-bounds component is playable; eligible disconnected roads are displayed, but are not artificially connected across the Bosphorus. OSM widths/lanes are used where available, otherwise defaults; widths are limited to 6.4–18 m, **intentionally widened for arcade driving**. One-way, conditional/turn restrictions, tram separation, signals and closures are not enforced.

## OSM detail and inference

The persisted manifest contains **58,492 buildings**, **349 building parts**, **1,915 green areas**, **58 water areas**, **7,078 surface pedestrian/path ways**, **1,461 mapped tree nodes**, **469 row-derived tree positions**, and **18,654 inferred trees**, in **2,273 detail tiles**. These are source/prepared object counts, not a claim that OSM maps every real object.

**Buildings.** Multipolygon members are joined in either direction; courtyard holes are retained. Three incomplete/unassigned source geometries are explicitly omitted and listed in the manifest, not arbitrarily closed. Valid `height` (metres/feet) takes priority; otherwise levels ×3 m plus tagged roof height; unknown height normally defaults to **9 m**, adjusted and labelled inferred if it conflicts with minimum-height tags. There are 580 declared-height objects, 1,678 level-derived objects and 56,583 default/inferred objects. **Both palaces lack height/levels tags and are explicitly 9 m inferred extrusions**, not bespoke palace architecture. Roof datum is stable across tile fragments, above sampled footprint terrain; walls/min-height bases follow terrain triangle crossings. Ground-level parts replace overlapping parent footprints. Widened asphalt overlap is trimmed from building geometry to keep driving clear; that is game engineering, not source footprint correction.

**Vegetation.** Natural-tree nodes retain exact OSM positions; missing tree dimensions are illustrative defaults. Tree rows are sampled along mapped lines about every 8 m: their individual positions are **derived**, not surveyed node positions. Greens containing mapped tree information receive no random infill. Other eligible parks/gardens/nature reserves/wood/forest use deterministic ID-seeded, jittered 10 m candidates with ≥5 m spacing. Holes, buildings, water, paved areas, roads (including non-playable/private motorways), sidewalk clearance, paths and existing trees are excluded. Explicit grass/lawns/meadows/pitches are not indiscriminately planted. Mapped, row-derived and inferred trees have distinct theme-derived shades and separate source counts in the UI.

**Landcover/paths/sidewalks.** Green, paved and mapped water polygons and surface paths are draped on terrain, not floating flat planes. Water is colored source geometry, **not bathymetry or physically level sea simulation**. Sidewalk side/exclusion tags are respected; otherwise urban-road strips are **inferred** (service/link streets do not default to them). Strip width 1.5 m and curb height 0.12 m are inferred dimensions. Junction strips subtract asphalt; parallel boundaries share a millimetre precision lattice to prevent floating-point ring failures. Curb walls split at every terrain triangle boundary, preventing long edges from spanning valleys as tall triangular fins. Explicit grade-separated paths are omitted rather than inventing vertical structure.

**Physics and vehicle.** TypeScript + Three.js, polygon-clipping and earcut. A deterministic **120 Hz ground-constrained arcade model** is simpler and more reliable here than a full rigid-body vehicle over coarse urban DSM. The approximately 3.8 × 1.8 m hatchback has an original lofted/bevelled body and cabin, angled windows, mirrors, bumper/grille, lights, fictional `TWIN 01` plate, alloy wheels, tire/arch details, clearcoat and a procedural contact shadow. Wheel spin uses the axle axis and front wheels visually steer with the existing controls.

The vehicle uses a heading-aligned **4.0 × 2.1 m** rectangular body envelope (including margin for mirrors/steered wheels), with perimeter samples no more than **0.25 m** apart against the asphalt union. The former 2.15 m radius circle unnecessarily reserved the car's length on both sides, triggering edge drag while its visible body was still inside the road. A straight 6.4 m road now allows a 4.3 m centre-position band instead of 2.1 m. Spawn, movement, slide candidates and the inspection surface use the same heading-aware footprint. Terrain shoulder blending does not classify asphalt or apply friction. At actual contact, sliding considers all roads containing the current centre, not just the closest centre-line; drag scales smoothly with the blocked fraction of intended motion. Tangential movement is retained, while a head-on impact still gets the original full slowdown and cannot leave the road. Sampling is approximate body collision, not independent wheel/rigid-body contact. Pitch is positive when the front axle rises; roll is positive when the right side rises. A quaternion built from an orthonormal surface tangent basis replaces mixed Euler tilt, fixing the reversed bank sign and keeping orientation correct after arbitrary yaw, including combined uphill/cross slopes. The starting/reset pose is sampled immediately, not left flat until the first driving tick. No gravity jumps, suspension, damage, independent wheel collisions or Rapier/WASM are claimed. Road-edge checks are approximate footprint collision, not precise car-body contact. Maximum forward speed is about 79 km/h; reverse about 25 km/h. Boundary stubs are dead ends; `R` is an explicit return to spawn, never an automatic jump across gaps.

The chase camera follows the car with damped motion and a terrain-height guard. Bird's-eye view is an alternate **3D camera**, not an AI-converted fixed screenshot.

The 3D canvas adapts pixel density under sustained frame pressure (minimum 0.5× CSS resolution), then gradually recovers on faster devices. HUD/text remain native resolution; **terrain/road geometry, data accuracy and physics do not change**. Hardware acceleration is recommended. The browser test reports median/p95 frame times and event-loop heartbeat gaps during a real key-driven chunk transition; headless SwiftShader results are software-renderer measurements, not hardware-GPU FPS promises.

## Why not the municipal viewer or isometric screenshot method?

The public [İBB City Map API developer documentation](https://sehirharitasiapi.ibb.gov.tr/developer/) requires an API key. During prior source research, direct municipal 3D elevation/scene requests returned **401 / “No Access To This Service!”**. The viewer having public JavaScript, or some datasets carrying an open-data license, does not grant access to every backend. This prototype neither extracts viewer tokens nor bypasses those controls.

[İBB describes municipal DTM/DSM and other surveying products](https://haritamudurlugu.ibb.istanbul/arazi-saha-calismalarimiz/), but no legitimately accessible documented small-area DTM download was established for this task. The coarser public Copernicus DSM is therefore disclosed and used instead.

[Isometric Istanbul's documentation](https://isometricistanbul.com/en/docs) describes a fixed-angle screenshot-to-2D-image workflow, not downloadable navigable terrain/road meshes. Its visual workflow is not used here; it cannot replace source elevation, road connectivity or free chase-camera driving. No Google imagery, watermark removal, screenshot-derived mesh, or AI image generation is involved.

## Prototype boundaries

No photorealistic/bespoke architecture, satellite textures, traffic, missions, multiplayer, sound or routing. The coarse **DSM already contains buildings/trees**; placing source footprints above it can overestimate building base/roof elevations. It is not bare-earth reconstruction. Distant details are culled and load as the car approaches; the overview is local, not a full-region detailed aerial render. Procedural asphalt/car materials are original content. This is a source-backed playable prototype, **not a digital-twin survey or navigation product**. Initial loading and software-renderer performance depend on device resources. A future municipal DTM needs legitimate access, redistribution terms and road-grade validation.
