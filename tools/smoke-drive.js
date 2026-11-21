// Google Drive in the desktop app, run inside Electron with --smoke=tools/smoke-drive.js
// --fake-google=<url> (tools/test.js starts the fake). Signs in through the loopback flow,
// copies a design to Drive, gets a new token silently, then signs out.
const app = window.dabble, lib = window.dabbleLib, native = window.dabbleNative, drive = lib.drive;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fails = [];
const out = {};
const check = (name, ok, got) => { if (!ok) fails.push(`${name} -> ${JSON.stringify(got)}`); };
const google = async () => JSON.parse((await native.driveFetch('https://www.googleapis.com/__state', {})).text);

try {
  check('desktop-route', drive.desktopDrive === true, drive.desktopDrive);
  // a build with the client built in starts signed out; otherwise Drive is off until one is pasted
  if (!drive.builtInClient()) {
    check('off-without-client', drive.getStatus().state === 'off', drive.getStatus().state);
    drive.setClientId('test-client', 'test-secret');
  }
  await drive.syncNow();
  check('signed-out', drive.getStatus().state === 'signedOut', drive.getStatus().state);

  // a design made before signing in
  await app.newDesign();
  app.editor.doc.name = 'Desk bracket'; app.nameInput.value = 'Desk bracket';
  app._markDirty();
  check('saved-locally', await app.flushSave(true), false);

  await drive.signIn(); // the "browser" is the fake Google, which answers straight away
  let g = await google();
  out.signIns = g.signIns;
  check('signed-in', drive.isLinked() && drive.getStatus().state === 'synced', drive.getStatus());
  check('account', (drive.account() || {}).email === 'me@example.com', drive.account());
  check('pkce-checked', g.signIns === 1, g.signIns);
  check('stays-signed-in', await native.driveHasSignIn(), false);
  check('folder-made', g.files.some((f) => f.name === 'DabbleCAD'), g.files.map((f) => f.name));

  await drive.copyAllToDrive();
  g = await google();
  const file = g.files.find((f) => f.name === 'Desk bracket.dabble');
  check('copied', !!file && file.content.includes('"app":"DabbleCAD"'), g.files.map((f) => f.name));

  // an edit autosaves and goes up
  app.editor.doc.notes = [];
  app._markDirty();
  await app.flushSave(true);
  await wait(3600);
  check('autosave-synced', drive.getStatus().pending === 0 && drive.getStatus().state === 'synced', drive.getStatus());

  // the access token runs out: a new one comes from the stored sign-in, with no window
  drive._forgetToken();
  await drive.syncNow();
  g = await google();
  out.refreshes = g.refreshes;
  check('silent-refresh', g.refreshes >= 1 && drive.getStatus().state === 'synced', [g.refreshes, drive.getStatus().state]);

  // sign out: forgotten here and revoked at Google
  drive.signOut();
  await wait(300);
  g = await google();
  check('signed-out-again', drive.getStatus().state === 'signedOut', drive.getStatus().state);
  check('revoked', g.revoked === 1, g.revoked);
  check('forgotten', !(await native.driveHasSignIn()), true);
  check('designs-kept', (await native.listDesigns()).some((m) => m.name === 'Desk bracket'), false);
} catch (err) {
  fails.push('error: ' + (err && err.message ? err.message : String(err)));
}

return { ...out, fails };
