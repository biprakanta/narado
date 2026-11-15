/**
 * narado desktop's packaging (desktop phase D4), on top of Bruno's: narado's name, app ID,
 * version, icons, entry point and narado:// links, with narado's code bundled into ./narado
 * by scripts/build-narado-desktop.js. Bruno's own build (electron-builder-config.js) is
 * unchanged.
 *
 * Signing is off unless configured:
 *   macOS    CSC_NAME (a "Developer ID Application" identity) or CSC_LINK/CSC_KEY_PASSWORD;
 *            NARADO_NOTARIZE=1 with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 *   Windows  CSC_LINK/CSC_KEY_PASSWORD (or WIN_CSC_LINK), publisher NARADO_WIN_PUBLISHER
 * Unsigned builds are for trying narado; macOS won't update an unsigned app by itself.
 */
const base = require('./electron-builder-config.js');
const naradoVersion = require('../bruno-web-server/package.json').version;

const macSigned = !!(process.env.CSC_NAME || process.env.CSC_LINK);
const protocols = [{ name: 'narado', schemes: ['narado'] }];

module.exports = {
  ...base,
  appId: 'co.narado.desktop',
  productName: 'narado',
  extraMetadata: {
    ...base.extraMetadata,
    name: 'narado',
    productName: 'narado',
    version: naradoVersion,
    description: 'API collections in Git, for your whole team.',
    main: 'src/narado-main.js'
  },
  directories: { buildResources: 'resources', output: 'out-narado' },
  files: ['**/*', '!out/**', '!out-narado/**', '!test/**', '!tests/**'],
  extraResources: base.extraResources,
  afterSign: process.env.NARADO_NOTARIZE === '1' ? 'notarize.js' : undefined,
  // Each organisation's narado server serves the updates (/desktop/updates/<platform>/); the
  // app points itself there at run time. This only makes the update files (latest*.yml).
  publish: [{ provider: 'generic', url: 'https://narado.invalid/desktop/updates' }],
  mac: {
    ...base.mac,
    artifactName: 'narado_${version}_${arch}_mac.${ext}',
    icon: 'narado/assets/icon.icns',
    // dmg to install, zip for updates.
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    identity: macSigned ? process.env.CSC_NAME || undefined : null,
    hardenedRuntime: macSigned,
    requirements: undefined,
    protocols
  },
  win: {
    ...base.win,
    artifactName: 'narado_${version}_${arch}_win.${ext}',
    icon: 'narado/assets/app-icon-512.png',
    signtoolOptions: process.env.NARADO_WIN_PUBLISHER ? { publisherName: process.env.NARADO_WIN_PUBLISHER } : undefined
  },
  nsis: {
    ...base.nsis,
    include: undefined,
    shortcutName: 'narado'
  },
  linux: {
    ...base.linux,
    artifactName: 'narado_${version}_${arch}_linux.${ext}',
    executableName: 'narado',
    icon: 'narado/assets/app-icon-512.png',
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] }
    ],
    protocols,
    desktop: { entry: { Name: 'narado', MimeType: 'x-scheme-handler/narado;' } }
  },
  deb: { ...base.deb, packageName: 'narado' },
  snap: undefined,
  pkg: undefined
};
