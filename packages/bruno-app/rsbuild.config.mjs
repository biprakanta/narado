import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginBabel } from '@rsbuild/plugin-babel';
import { pluginStyledComponents } from '@rsbuild/plugin-styled-components';
import { pluginSass } from '@rsbuild/plugin-sass';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';
import { pluginRemoteImages } from './plugins/remote-images/index.mjs';

const require = createRequire(import.meta.url);
const swaggerUiDir = path.dirname(require.resolve('swagger-ui-react'));
const swaggerImmutable = require.resolve('immutable', { paths: [swaggerUiDir] });

const remoteImageDomains = (process.env.BRUNO_REMOTE_IMAGE_DOMAINS || 'd3icksk7srk4uh.cloudfront.net')
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean);

const NARADO_BRAND = process.env.BRUNO_BRAND !== 'bruno';
// Bump when narado's icons change, so browsers don't keep showing a cached one.
const ICON_VERSION = '2';

export default defineConfig({
  plugins: [
    pluginNodePolyfill(),
    pluginReact(),
    pluginStyledComponents(),
    pluginSass(),
    pluginBabel({
      include: /\.(?:js|jsx|tsx)$/,
      babelLoaderOptions(opts) {
        opts.plugins?.unshift('babel-plugin-react-compiler');
      }
    }),
    pluginRemoteImages({
      domains: remoteImageDomains,
      include: [/\.md$/]
    })
  ],
  source: {
    define: {
      __BRUNO_BENCHMARK__: JSON.stringify(process.env.BRUNO_BENCHMARK === 'true')
    },
    tsconfigPath: './jsconfig.json', // Specifies the path to the JavaScript/TypeScript configuration file,
    exclude: [
      '**/test-utils/**',
      '**/*.test.*',
      '**/*.spec.*'
    ],
  },
  resolve: {
    // swagger-ui-react nests immutable@3 (CJS default export). sass hoists
    // immutable@5 to the repo root, which dropped that default; redux-immutable
    // is also hoisted there, so without this alias it loads v5 and crashes.
    alias: {
      immutable$: swaggerImmutable
    }
  },
  // narado's page title and icons in the HTML itself (not only set later by script), so the
  // browser never shows another icon first. BRUNO_BRAND=bruno builds Bruno's own look.
  html: NARADO_BRAND
    ? {
        title: 'narado',
        // rsbuild links /favicon.ico by itself; make that narado's too.
        favicon: './public/narado/favicon.ico',
        tags: [
          { tag: 'link', attrs: { rel: 'icon', type: 'image/svg+xml', href: `/narado/narado-favicon.svg?v=${ICON_VERSION}` }, head: true },
          { tag: 'link', attrs: { rel: 'alternate icon', sizes: '16x16 32x32 48x48', href: `/narado/favicon.ico?v=${ICON_VERSION}` }, head: true },
          { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `/narado/favicon-180.png?v=${ICON_VERSION}` }, head: true },
          { tag: 'meta', attrs: { name: 'theme-color', content: '#21004B' }, head: true },
          { tag: 'meta', attrs: { name: 'application-name', content: 'narado' }, head: true },
          { tag: 'meta', attrs: { name: 'description', content: 'API collections in Git, for your whole team.' }, head: true },
          { tag: 'link', attrs: { rel: 'manifest', href: `/narado/manifest.webmanifest?v=${ICON_VERSION}` }, head: true }
        ]
      }
    : { title: 'Bruno' },
  // Web build: forward the IPC WebSocket to packages/bruno-web-server.
  // Unused by the Electron app, which talks to its main process directly.
  server: {
    proxy: {
      '/ipc': {
        target: process.env.BRUNO_WEB_SERVER || 'http://127.0.0.1:4100',
        ws: true
      },
      // Sign-in routes (narado Phase 4b).
      '/auth': {
        target: process.env.BRUNO_WEB_SERVER || 'http://127.0.0.1:4100'
      },
      // narado desktop's channel to the server (desktop phase D2).
      '/desktop/api': {
        target: process.env.BRUNO_WEB_SERVER || 'http://127.0.0.1:4100'
      },
      // narado's /favicon.ico (the browser asks for it on its own).
      '/favicon.ico': {
        target: process.env.BRUNO_WEB_SERVER || 'http://127.0.0.1:4100'
      },
      // Setup and admin pages.
      '/setup': {
        target: process.env.BRUNO_WEB_SERVER || 'http://127.0.0.1:4100'
      },
      '/admin': {
        target: process.env.BRUNO_WEB_SERVER || 'http://127.0.0.1:4100'
      }
    }
  },
  tools: {
    rspack: {
      module: {
        parser: {
          javascript: {
            // This loads the JavaScript contents from a library along with the main JavaScript bundle.
            dynamicImportMode: "eager",
          },
        }
      },
      ignoreWarnings: [
        (warning) => warning.message.includes('Critical dependency: the request of a dependency is an expression') && warning?.moduleDescriptor?.name?.includes('flow-parser')
      ],
      // Add externals configuration to exclude Node.js libraries
      externals: {
        // List specific Node.js modules you want to exclude
        // Format: 'module-name': 'commonjs module-name'
        'node:worker_threads': 'commonjs worker_threads',
        // 'path': 'commonjs path'
      },
      optimization: {
        splitChunks: {
          cacheGroups: {
            // CodeMirror's modes/addons/themes + codemirror-graphql are all
            // required upfront (pages/Bruno/index.js) but rarely change —
            // pulling them into their own initial chunk lets the browser
            // fetch it in parallel with the main bundle instead of inflating
            // one monolithic file.
            codemirror: {
              test: /[\\/]node_modules[\\/]codemirror(-.*)?[\\/]/,
              name: 'lib-codemirror',
              chunks: 'all',
              priority: 10
            }
          }
        }
      }
    },
  }
});