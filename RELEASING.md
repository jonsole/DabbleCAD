# Preparing and publishing releases

The release process builds a Windows x64 installer and no-install ZIP, separate
macOS Intel and Apple Silicon DMGs/ZIPs, and a Linux x64 AppImage. Desktop editing works offline; dependency
installation, build-tool downloads, and GitHub publishing require internet.

## Local builds

Use Node.js 24.x and run `npm ci`. Build on the target operating system:

```sh
# Windows: installer + portable ZIP
npm run test:all
npm run package:win
npm run test:packaged

# macOS: DMG + ZIP for Intel and Apple Silicon
npm run test:all
npm run package:mac
npm run test:packaged

# Linux: x64 AppImage (prefix the test commands with xvfb-run -a when headless)
npm run test:all
npm run package:linux
npm run test:packaged
```

Output is `release/<package.json version>/`. `test:packaged` tests the unpacked app
matching the host CPU; building both Mac architectures on one Mac does not prove
that both run. CI uses separate native runners for that reason.

To test an extracted Windows ZIP rather than the unpacked build directory:

```powershell
node tools\test.js --app="C:\path\to\extracted\"DabbleCAD Plus.exe""
```

The renderer is bundled by Vite. electron-builder's explicit file list includes
only runtime files, the icon, metadata, and licenses. Development dependencies,
source test fixtures, local designs, and credentials are not release content.
`private: true` in package.json prevents accidental npm publication; it does not
make the GitHub repository private.

## GitHub Actions

`.github/workflows/build.yml` builds Windows x64, macOS Intel, macOS Apple Silicon,
and Linux x64. The Linux job runs the suites under Xvfb with software rendering.
Branch and manual builds also package and test the resulting apps, then upload
downloadable workflow artifacts. Pull requests run source tests without publishing.

A pushed `v*` tag additionally:

1. Verifies the tag is exactly `v` plus the version in package.json.
2. Runs the source and packaged suites offline on the native runners that can
   create a WebGL view.
3. Requires exactly the seven expected non-empty distributables.
4. Generates `SHA256SUMS.txt`.
5. Creates a **draft** GitHub Release with the files and `RELEASE_NOTES.md`.

No draft is made public automatically. Build jobs have read-only repository
permissions; only the final tag-release job has `contents: write`.
Actions are pinned to commit hashes. Review and update those pins periodically.
The local packaging scripts explicitly disable automatic publishing.

## First public push

Before uploading, review every file being committed. The ignore file is only a
guardrail, not a secret scanner. Do not include personal designs, credentials,
private keys, signing certificates, generated binaries, or dependency folders.

The following is a maintainer procedure, not something local packaging executes:

```sh
git add .gitignore .github LICENSE NOTICE README.md CONTRIBUTING.md SECURITY.md RELEASING.md RELEASE_NOTES.md THIRD_PARTY_NOTICES.md package.json package-lock.json electron-builder.json vite.config.mjs build electron src tools
git diff --cached --stat
git diff --cached --check
git diff --cached
git commit -m "Prepare DabbleCAD for its first public release"
git branch -M main
gh repo create DJMcNewgent/DabbleCAD --public --source=. --remote=origin --push --description "An offline, open-source alternative to Tinkercad for 3D design and 3D printing, plus laser projects and depth maps. Runs locally; no account needed."
```

If the repository or remote already exists, use it instead of creating another.
Enable GitHub Actions and private vulnerability reporting, then add repository
topics such as `cad`, `electron`, `3d-printing`, `laser`, and `offline`.
No personal token needs to be committed or pasted into a workflow.

## Release checklist

- Update package.json and package-lock.json together, and rewrite RELEASE_NOTES.md
  for that version. Review bundled component licenses.
- Run the five source suites and packaged suites. Review any expected test-error
  logs rather than suppressing them.
- Run `npm audit`. At initial preparation, electron-builder 26.18.0's build-tool
  dependency tree reports six moderate advisories from
  [minimatch glob amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249).
  These packages are not shipped as app dependencies. Review upstream fixes;
  do not blindly run `npm audit fix --force`, which proposes a packager downgrade.
- Manually install/uninstall the Windows installer without deleting your design
  library. Test the ZIP after extraction into a clean folder.
- Launch both Mac builds on their respective hardware and verify OS trust behavior.
- Launch the AppImage on a desktop Linux system with a real GPU. `test:packaged`
  covers the unpacked app under software rendering, not the AppImage itself.
- Test offline launch, editing, save/reopen, file import/export, and native close/
  restart prompts. Keep known geometry limitations in the notes.
- Validate any claimed laser/controller support with appropriate supervised
  hardware testing; automated G-code checks alone are insufficient.
- Keep backups and do not claim that tests certify all geometry or machine safety.

After the source has been reviewed and pushed:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Wait for all jobs to pass. Open the draft under Releases, inspect its seven files and
checksums, download and check the distributions, and publish the draft only when
ready. A rerun will not overwrite an existing release automatically: if creation
reports that a release already exists, inspect that release before taking action.

## Unsigned builds

The initial release is intentionally unsigned by a trusted publisher:

- **Windows:** SmartScreen may warn about an unknown publisher.
- **macOS:** `identity: "-"` supplies an ad-hoc signature. It is not an Apple
  Developer ID signature and the app is not notarized. Gatekeeper may block it.

Only trust files from the official repository. Compare SHA-256 values:

```powershell
Get-FileHash .\DabbleCAD-Plus-1.0.0-win-x64-setup.exe -Algorithm SHA256
```

```sh
shasum -a 256 DabbleCAD-Plus-1.0.0-mac-arm64.dmg
```

Use the operating system's per-app approval flow only if you have verified and
trust the download. Do not instruct users to disable antivirus or Gatekeeper
globally. See [Apple's guidance on safely opening apps](https://support.apple.com/102445).
Managed computers may prohibit unsigned software; source builds are not a promise
that organizational restrictions can be bypassed.

Trusted signing/notarization can be added later using CI secrets. That requires
revisiting the Mac identity, hardened-runtime, entitlements, and notarization settings
and testing them; simply adding a secret does not turn these builds into notarized
ones. Never commit signing credentials.

## Build references

- [electron-builder](https://www.electron.build/) — this project pins stable 26.18.0;
  the website's default documentation may describe unreleased v27 options.
- [GitHub-hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- [GitHub CLI release command](https://cli.github.com/manual/gh_release_create).
