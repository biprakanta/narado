/**
 * Product identity. The web build and narado desktop are narado (built on Bruno); Bruno's
 * own Electron app stays Bruno. Bruno's file format and import/export type keep the name
 * Bruno everywhere.
 *
 *   isNarado()        narado, in a browser or on the desktop
 *   isNaradoWeb()     narado in a browser, talking to the server (window.isBrunoWeb)
 *   isNaradoDesktop() narado desktop (set by its preload)
 */
export const isNaradoWeb = () => typeof window !== 'undefined' && !!window.isBrunoWeb;
export const isNaradoDesktop = () => typeof window !== 'undefined' && !!window.isNaradoDesktop;
export const isNarado = () => isNaradoWeb() || isNaradoDesktop();
/** Where narado keeps things: "on the server" in a browser, "on this computer" on the desktop. */
export const naradoWhere = () => (isNaradoDesktop() ? 'on this computer' : 'on the server');
export const productName = () => (isNarado() ? 'narado' : 'Bruno');

export const NARADO_REPO_URL = 'https://github.com/biprakanta/narado';
export const BRUNO_REPO_URL = 'https://github.com/usebruno/bruno';
export const repoUrl = () => (isNarado() ? NARADO_REPO_URL : BRUNO_REPO_URL);
