const { ipcMain } = require('electron');
const os = require('os');
const { BrowserWindow } = require('electron');
const { version } = require('../../package.json');
const aboutBruno = require('./about-bruno');
const aboutNarado = require('./about-narado');

const NARADO = process.env.NARADO_DESKTOP === '1';

const template = [
  {
    label: 'Collection',
    submenu: [
      {
        label: 'Open Collection',
        click() {
          ipcMain.emit('menu:open-collection');
        }
      },
      {
        label: 'Open Recent',
        role: 'recentdocuments',
        visible: os.platform() == 'darwin',
        submenu: [
          {
            label: 'Clear Recent',
            role: 'clearrecentdocuments'
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click() {
          ipcMain.emit('main:start-quit-flow');
        }
      },
      {
        label: 'Force Quit',
        click() {
          process.exit();
        }
      }
    ]
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' }
    ]
  },
  {
    label: 'View',
    submenu: [
      { role: 'toggledevtools' },
      { type: 'separator' },
      {
        label: 'Actual Size',
        accelerator: 'CommandOrControl+0',
        registerAccelerator: false,
        click() {
          ipcMain.emit('menu:reset-zoom');
        }
      },
      {
        label: 'Zoom In',
        accelerator: 'CommandOrControl+Plus',
        registerAccelerator: false,
        click() {
          ipcMain.emit('menu:zoom-in');
        }
      },
      {
        label: 'Zoom Out',
        accelerator: 'CommandOrControl+-',
        registerAccelerator: false,
        click() {
          ipcMain.emit('menu:zoom-out');
        }
      },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  },
  {
    role: 'window',
    submenu: [{ role: 'minimize' }, { role: 'close', accelerator: 'CommandOrControl+Shift+Q' }]
  },
  {
    role: 'help',
    submenu: [
      {
        label: NARADO ? 'About narado' : 'About Bruno',
        click: () => {
          const aboutWindow = new BrowserWindow({
            width: NARADO ? 360 : 350,
            height: NARADO ? 300 : 250,
            title: NARADO ? 'About narado' : 'About Bruno',
            backgroundColor: NARADO ? '#17121F' : undefined,
            webPreferences: {
              nodeIntegration: false
            }
          });
          aboutWindow.removeMenu();
          const html = NARADO ? aboutNarado({ version }) : aboutBruno({ version });
          aboutWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        }
      },
      // Bruno's documentation; narado's own help comes from the team's server.
      ...(NARADO ? [] : [{ label: 'Documentation', click: () => ipcMain.emit('main:open-docs') }])
    ]
  }
];

module.exports = template;
