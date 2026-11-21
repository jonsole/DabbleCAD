# CuraEngine (WebAssembly) — provenance and license

This folder holds a prebuilt WebAssembly build of **CuraEngine** plus its setting definitions, used by
DabbleCAD's "Slice to G-code" feature. Everything here except `slicer-worker.js` is third-party.

| File | What it is | License |
| --- | --- | --- |
| `CuraEngine.js`, `CuraEngine.wasm`, `CuraEngine.data` | CuraEngine compiled with Emscripten by SynDaver Labs from <https://github.com/SynDaverCO/CuraEngine> (a fork of Ultimaker's CuraEngine) | AGPL-3.0 |
| `fdmprinter.def.json`, `fdmextruder.def.json` | Cura printer/extruder setting definitions | LGPL-3.0 (Ultimaker Cura) |
| `slicer-worker.js` | DabbleCAD's worker that runs the engine | Apache-2.0 |

The binaries were copied unmodified from `src-app/lib/slicing-engines/CuraEngine/` in
<https://github.com/SynDaverCO/symple-slicer> at commit `6e580c4591c90ac235c6a5dd8e9a58c1faf82c39`
(Symple Slicer is also AGPL-3.0). They were not rebuilt for DabbleCAD.

## Source offer (AGPL-3.0 section 6 / 13)

The corresponding source of the engine is available at <https://github.com/SynDaverCO/CuraEngine>, and the
build script is `build-cura-engine.sh` in the Symple Slicer repository above. The AGPL requires anyone who
distributes this build, or serves it to users over a network (for example on GitHub Pages), to make that
source available to them and to license the engine under the AGPL. The engine runs as a separate program
inside a Web Worker and is not linked into DabbleCAD's own code, but if you distribute a combined work,
check what that means for your own license choice.

## Updating the engine

Rebuild CuraEngine with Emscripten (see the Symple Slicer build script) or copy a newer build from
Symple Slicer, replace the three engine files and the two definition files together (they must match), and
re-run a test slice.
