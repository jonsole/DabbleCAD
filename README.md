<p align="center"><img src="docs/logo.png" alt="DabbleCAD" width="560"></p>

# DabbleCAD

**One offline, open-source app for 3D design, laser projects, and depth maps.**

DabbleCAD puts three maker tools in a single desktop app, saved together in one design:

- **3D Design:** shape-based modeling inspired by Tinkercad. Drag shapes onto a
  workplane, stretch and rotate them, turn some into holes, group them into one part,
  and export an STL or 3MF for your slicer.
- **Laser:** draw or import artwork, set up layers, preview the job, and export
  G-code or send it to a GRBL-compatible laser over USB.
- **Depth Map Studio:** turn a 3D model or an image into a height map for relief
  engraving.

Model a part, bring its outline into the laser workspace, or turn it into a relief,
without exporting and re-importing between apps. DabbleCAD runs locally, your designs
stay on your computer, and it needs no account and no internet connection.

**[Download the latest release](https://github.com/DJMcNewgent/DabbleCAD/releases/latest)**
for Windows or Mac. It is free, and there is nothing to sign up for.
See [first launch](#first-launch) for the one-time security prompt.

[All releases](https://github.com/DJMcNewgent/DabbleCAD/releases) ·
[Report a bug](https://github.com/DJMcNewgent/DabbleCAD/issues) ·
[Ask a question](https://github.com/DJMcNewgent/DabbleCAD/discussions) ·
[Contribute](CONTRIBUTING.md)

![Resizing a box on the workplane and orbiting the view in DabbleCAD](docs/demo.gif)

## Screenshots

**3D Design** — drag shapes onto the workplane, resize them, and combine them into parts.

![3D Design workspace](docs/screenshot-3d-design.png)

**Laser** — draw or import artwork, set up layers, and send the job to your laser.

![Laser workspace](docs/screenshot-laser.png)

**Depth Map Studio** — turn an STL model or an image into a height map for relief engraving.

![Depth Map Studio](docs/screenshot-depth-map.png)

## Why I built this

I'm a tinkerer. I kept jumping between different apps for the things I like to do,
and I wanted those tools together in one place.

DabbleCAD is my start at building that workspace. Right now, it brings together
3D design, laser work, and depth-map tools. The goal is to spend less time switching
apps and more time making things.

**This is just the start. More to come.**

— [DJMcNewgent](https://github.com/DJMcNewgent)

## Works offline

**The desktop app works without an internet connection**, including the installed
Windows app, the extracted portable ZIP, and the Mac app.

- Create and edit 3D and laser designs locally.
- Save your design library on your computer.
- Import and export local files, generate G-code, and use Depth Map Studio.
- Use bundled fonts or supported fonts already installed on your computer.
- Connect to a compatible laser over local USB serial; no cloud service is required.

No account or cloud service is required for these workflows. Internet is needed to
download the app or a new version, visit external links, and initially install
development dependencies or any device drivers your computer needs. There is no
cloud sync, and nothing updates without you asking.

The one thing the app does online by itself: when it starts, it asks GitHub whether a
newer release exists and shows a note if so. The request carries nothing about you or
your designs, fails silently when you are offline, and can be switched off under
**Settings → Updates**.

### Updating

**Settings → Updates → Check for updates** (also in the About dialog) looks for a newer
release on GitHub, downloads the build for your computer, and checks it against the
release's SHA-256 list before using it.

- **Windows, installed:** the new version installs over the old one and the app restarts.
- **Windows, portable ZIP:** the new ZIP is downloaded and shown in its folder.
- **Mac:** the disk image opens so you can drag the new app into Applications.
- **Linux AppImage:** the AppImage is replaced and the app restarts.

Your designs and settings live in your user data folder, not in the app folder, so
they carry over to the new version.

## Download and install

Published builds are attached to [GitHub Releases](https://github.com/DJMcNewgent/DabbleCAD/releases),
not GitHub's automatically generated **Source code** archives. Open the
[latest release](https://github.com/DJMcNewgent/DabbleCAD/releases/latest) and
pick the file for your computer under **Assets**.

Each release provides:

- **Windows x64 installer:** `DabbleCAD-VERSION-win-x64-setup.exe`.
  Run the installer and choose the installation folder.
- **Windows x64 portable ZIP:** `DabbleCAD-VERSION-win-x64.zip`.
  Extract the entire archive, then run `DabbleCAD.exe`. No installation is required;
  keep the other extracted files beside the executable.
- **Mac, Apple Silicon:** `DabbleCAD-VERSION-mac-arm64.dmg` and `.zip`.
- **Mac, Intel:** `DabbleCAD-VERSION-mac-x64.dmg` and `.zip`.
  Open the DMG and drag DabbleCAD to Applications, or extract the ZIP and move the
  `.app` bundle to Applications. Choose the build matching **About This Mac**.
- **Linux x64 AppImage:** `DabbleCAD-VERSION-linux-x64.AppImage`, starting with
  the release after 1.0.0. Mark it executable (`chmod +x`), then run it. It passes
  the automated suites with software rendering but has not yet been checked by hand
  on desktop Linux distributions; reports are welcome.
- **Checksums:** `SHA256SUMS.txt` for verifying the downloads.

These initial builds do **not** have a trusted publisher signature or Apple
notarization. Windows SmartScreen and macOS Gatekeeper may warn or block launch.
Mac builds use an ad-hoc signature, not a verified Developer ID. Only use downloads
from this repository and compare their checksums. Do not disable your computer's
security protections globally; see [release guidance](RELEASING.md#unsigned-builds).

### First launch

Because the builds are not signed by a trusted publisher, your computer asks once
before running DabbleCAD. Check the download against `SHA256SUMS.txt` first, then
approve only this app:

**Windows**

1. Run the installer, or `DabbleCAD.exe` from the extracted ZIP.
2. If a blue **Windows protected your PC** window appears, select **More info**.
3. Confirm the app name, then select **Run anyway**.

**Mac**

1. Open DabbleCAD from Applications. macOS says it could not verify the app;
   select **Done**.
2. Open **System Settings → Privacy & Security** and scroll to **Security**.
3. Next to the DabbleCAD message, select **Open Anyway**, then confirm.

On macOS 14 and earlier, Control-click the app and choose **Open** instead.
You only need to do this the first time. If the prompt does not offer these
choices, your computer may be managed by an organization that blocks unsigned
apps; DabbleCAD does not work around that.

### Where designs live

Desktop designs and settings are stored in your operating system's application-data
folder. Open **Your designs → Library folder** to locate your saved designs.
Export `.dabble` files for backups or moving work to another computer.

**Portable means no installer**, not portable storage: the Windows ZIP still uses
the computer's application-data folder. Copying only the app folder does not copy
your design library. In browser development mode, designs use that browser's local
storage instead and are separate from the desktop library.

## What you can do

### 3D design

- 60+ parametric shapes, text, letters, numbers, starter models, and saved creations.
- Solid, hole, transparent, and multicolor objects.
- Union, intersection, bundles, and ungrouping. Groups are built by a solid-modelling
  kernel, so the result is a closed, printable mesh.
- Edit the parts of a group without ungrouping: double-click it, change things, press Done.
- Round or bevel the outside edges of any shape or group.
- **Modes** (toolbar, next to Undo/Redo, or keys 1 to 4): **Object** for whole shapes;
  **Face** to push or pull a flat face; **Edge** to round, chamfer or move edges;
  **Corner** to move corners. Drag the arrows or type a distance. Moves stay editable
  and work on groups too.
- Resize, rotate, lift, mirror, align, and type exact dimensions.
- Workplanes on faces, a ruler, notes, patterns, duplicate-and-repeat, and Cruise.
- Freehand Scribble shapes with extrusion.
- **Sketch:** draw rectangles, circles, and polygons with typed sizes and cut-outs,
  then pull the outline up into 3D. Double-click the result to edit the sketch.
- **Generators** in real millimetres: bolts and nuts with printable threads,
  standoffs, a two-leaf hinge, snap clips, and a box with a fitted lid.
- **Print check:** before exporting, find shapes that are not closed solids, parts
  floating above the plate, thin walls, steep overhangs, and designs too big for
  your printer bed, with a one-click fix for resting the design on the plate.
- **Open in slicer:** send the design straight to your slicer from the Export dialog.
- A getting-started guide on first launch (reopen it from the **?** button).
- Blocks and Bricks views.
- Size, volume, and weight estimates.

**Import:** STL, OBJ, GLB/glTF, 3MF, PLY meshes, SVG, PNG/JPG, and `.dabble`.
**Export:** STL, 3MF, OBJ, GLB, SVG outlines, PNG pictures, and `.dabble`.
Some complex file features may not be preserved; inspect imported geometry.

### Laser workspace

Switch to **Laser** at the top of the app. The laser workspace is saved with the
same design as your 3D work.

- Draw and edit lines, curves, rectangles, ellipses, polygons, text, and images.
- 30 color layers plus two tool layers; Line, Fill, and Offset Fill modes.
- Speed, power, passes, interval, scan angle, cross-hatch, overscan, kerf, tabs,
  and air-assist settings.
- Weld, subtract, intersect, exclude, offset, arrays, trace, align, distribute,
  flip, and rotate.
- Image engraving with threshold, dithering, and grayscale options.
- QR codes, material tests, interval tests, and outlines from the 3D workspace.
- **Box maker:** finger-jointed panels for a laser-cut box from its width, depth,
  height, material thickness, and kerf.
- **Material library:** save a layer's speed, power, and passes under a name of
  your own and apply it to other layers and projects.
- Preview, estimated job time, G-code export, and USB serial controls for
  GRBL-compatible machines.
- SVG, DXF, and image import; SVG, DXF, and G-code export.

Set the work area, origin, and controller under **Device**. Software tests do not
certify compatibility with every controller or machine. Inspect generated paths
and settings, follow your laser manufacturer's safety instructions, and never
leave an operating laser unattended.

### Depth Map Studio

Create a height map from an STL, an image, or the current 3D design. Adjust levels,
gamma, output range, smoothing, and inversion; inspect a 3D relief preview; get
slice/spot-size guidance; and export 16-bit PNG, 8-bit PNG, or slice masks. A depth
map can go onto the bed as one grayscale engraving, or as **slice passes**: one mask
per pass, each on its own layer, so the laser cuts the relief step by step.
Suggested material settings are starting points, not calibrated guarantees.

### Google Drive

You can keep your design library in your own Google Drive, in the web version and the
desktop app alike, so the same designs are there on any computer. Sign in from **Your designs → Sign in to Google
Drive**. Designs then live in a **DabbleCAD** folder in your Drive as normal `.dabble`
files (with a preview picture), and every save, rename and delete is synced.

- Saves always go to the browser first, so nothing waits on the network. If Drive can't
  be reached, designs show a crossed-out cloud ("not synced yet") and upload when you're
  back online.
- Designs made before you signed in stay in the browser until you choose
  **Copy my designs to Drive**.
- Deleting a design moves its Drive file to the Drive bin, where it can be restored.
- If the same design is changed on two computers, the most recent save wins.
- DabbleCAD asks only for access to files it creates (the `drive.file` permission), so
  it can't see anything else in your Drive. There's no DabbleCAD server: the app
  talks to Google directly.
- **Web version:** sign-in lasts about an hour; after that the button says
  **Reconnect Drive** and one click carries on.
- **Desktop app:** sign-in opens your normal web browser at Google's page, then
  returns to DabbleCAD. It stays signed in (the sign-in is kept encrypted in your
  system's keychain) until you choose **Sign out**.
- Both use the same **DabbleCAD** folder, so designs move between them.
- Signed out, nothing changes: designs stay on this computer only.

**Setting it up for your copy of DabbleCAD** (once, about 10 minutes). The links open
the right page of the [Google Cloud console](https://console.cloud.google.com/) for the
project selected at the top left:

1. Create a project (project picker at the top left → **New project**) and select it.
2. [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com): press **Enable**.
3. [Google Auth Platform](https://console.cloud.google.com/auth/overview): press **Get started**.
   App name *DabbleCAD*, your email as support and contact email, audience **External**.
   Don't add a logo: that would require Google's review.
4. [Audience](https://console.cloud.google.com/auth/audience): add your Google account under
   **Test users** (while the app is in *Testing*, sign-ins expire after 7 days), or press
   **Publish app**. With only the `drive.file` permission and no logo, publishing normally
   doesn't need Google's verification.
5. [Clients](https://console.cloud.google.com/auth/clients) → **Create client**: type
   **Web application**, authorised JavaScript origin `https://<your-user>.github.io`
   (and `http://localhost:5183` for development). No redirect URI is needed, and the client
   secret isn't used.
6. Put the client ID in `src/renderer/config.js` (`GOOGLE_CLIENT_ID`) and push; or, just
   to try it, paste it into **Settings → Google Drive** in one browser.
7. For the desktop app: [Clients](https://console.cloud.google.com/auth/clients) →
   **Create client** again, type **Desktop app**. No redirect URIs are needed. Add its
   client ID and client secret as repository secrets `GOOGLE_DESKTOP_CLIENT_ID` and
   `GOOGLE_DESKTOP_CLIENT_SECRET` (**Settings → Secrets and variables → Actions**); the
   build puts them into the app. To try it without a build, paste both into
   **Settings → Google Drive** in the desktop app.

The web client ID is not a secret; it only identifies the app to Google. Google doesn't
treat a desktop client's secret as confidential either, but it's kept out of the
repository anyway. If you fork this
repository, replace the one in `config.js` with your own (it only works from the
origins its owner allowed).

## Saving

`Ctrl+S` (or `Cmd+S` on Mac) saves the design and its laser workspace, even with
auto-save off.

With auto-save off and unsaved changes, DabbleCAD asks **Save / Don't save / Cancel**
before opening the dashboard, switching or creating designs, deleting the current
design, restarting from Settings, or closing the desktop app. Cancel preserves your
current edits; a failed save stops the transition. Don't save leaves the saved copy
unchanged, except that deleting a design still removes that copy.

## Navigation

- **Orbit:** right-drag, or Ctrl + left-drag.
- **Pan:** middle-drag, or Shift + right-drag.
- **Zoom:** scroll wheel, `+`, or `-`.
- **Fit / Home:** `F` / `Home`.
- **Perspective / orthographic:** `O`.
- **View cube:** click a face or drag it.

Press `?` for the full shortcut list. Dark and light themes, graphics settings,
shadows, and edge display are available in Settings. If the graphics driver crashes
repeatedly, the app can fall back to software rendering (Windows and Linux; a Mac needs a working GPU).

## Run from source

Requires **Node.js 24.x**, npm, and a desktop session. Node.js is not needed to run
a downloaded release.

```sh
git clone https://github.com/DJMcNewgent/DabbleCAD.git
cd DabbleCAD
npm ci
npm start
```

- `npm run dev`: browser development at `http://localhost:5183`.
- `npm run build`: build the renderer.
- `npm run test:all`: run all five functional suites with HTTP/WebSocket requests blocked.
- `npm run package:win`: Windows installer and portable ZIP; run on Windows.
- `npm run package:mac`: Intel and Apple Silicon DMG/ZIP builds; run on macOS.
- `npm run package:linux`: x64 AppImage; run on Linux.
- `npm run test:packaged`: run the same offline suites against the packaged app
  for the host architecture.

Build output goes in `release/VERSION/`. See [RELEASING.md](RELEASING.md) for CI,
checksums, unsigned builds, and the public-release checklist.

## Project status and limitations

DabbleCAD is an early project, not a claim of production certification.

- Rounding or bevelling edges keeps the overall size but makes holes and gaps
  slightly tighter, and very detailed shapes are refused because they take too long.
- The print check is a quick geometric estimate, not a slicer. Imported meshes that
  are not closed solids fall back to a simpler grouping method.
- Generator threads use a rounded printable profile, not a machined ISO thread. Print
  a bolt and nut pair and adjust the clearance before relying on a fit.
- Complex imported geometry and advanced SVG/DXF/3MF features need inspection.
- Estimates and suggested laser settings are not material-specific calibration.
- Real laser hardware, native close dialogs, installation, and operating-system
  trust prompts need manual testing in addition to automated tests.
- Mac release builds must pass the macOS CI jobs and manual launch checks before
  being treated as verified downloads.

Bug reports, reproducible examples, documentation improvements, and feature ideas
are welcome. Please remove private designs and personal information before sharing
files publicly. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License and credits

Created by [DJMcNewgent](https://github.com/DJMcNewgent).
Licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE).
Version 1.0.0 was released under the MIT License.

Built with Electron, Three.js, Manifold, three-mesh-bvh, three-bvh-csg, OpenType.js,
Clipper, QR Code Generator, and Roboto. See
[third-party notices](THIRD_PARTY_NOTICES.md) for component licenses.

## Trademarks

DabbleCAD is an independent project, not affiliated with or endorsed by Autodesk.
Tinkercad is a trademark of Autodesk, Inc.
