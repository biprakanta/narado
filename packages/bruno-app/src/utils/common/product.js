/**
 * Product identity. The web build is narado (built on Bruno); the Electron app stays Bruno.
 * Bruno's file format and import/export type keep the name Bruno in both.
 */
export const isNarado = () => typeof window !== 'undefined' && !!window.isBrunoWeb;
export const productName = () => (isNarado() ? 'narado' : 'Bruno');

export const NARADO_REPO_URL = 'https://github.com/biprakanta/narado';
export const BRUNO_REPO_URL = 'https://github.com/usebruno/bruno';
export const repoUrl = () => (isNarado() ? NARADO_REPO_URL : BRUNO_REPO_URL);
