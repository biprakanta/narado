// narado desktop's entry point in a packaged app (electron-builder-narado.js sets it as
// "main"): the same app as Bruno's, started as narado.
process.env.NARADO_DESKTOP = '1';
require('./index');
