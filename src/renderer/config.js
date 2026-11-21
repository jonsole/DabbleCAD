// Settings that belong to this copy of DabbleCAD rather than to one browser.

/**
 * OAuth client ID for saving designs to your own Google Drive (Web application type, with
 * this site as an authorised JavaScript origin). Not a secret: it only works from the origins
 * listed for it in Google Cloud Console. Leave empty to turn Google Drive off; it can also be
 * pasted into Settings in one browser for trying it out.
 */
export const GOOGLE_CLIENT_ID = '703682097501-jr4g217gp0f0rokacojp4fjfa9nf3l44.apps.googleusercontent.com';

/**
 * OAuth client for the desktop app (Desktop app type, same Google Cloud project). Google treats
 * a desktop client's "secret" as not confidential, but it is kept out of the repository: the
 * build reads it from the VITE_GOOGLE_DESKTOP_CLIENT_SECRET environment variable (a GitHub
 * Actions secret). Both can also be pasted into Settings on one computer for trying it out.
 */
export const GOOGLE_DESKTOP_CLIENT_ID = import.meta.env.VITE_GOOGLE_DESKTOP_CLIENT_ID || '';
export const GOOGLE_DESKTOP_CLIENT_SECRET = import.meta.env.VITE_GOOGLE_DESKTOP_CLIENT_SECRET || '';
