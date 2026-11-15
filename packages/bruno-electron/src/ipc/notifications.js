require('dotenv').config();
const { ipcMain } = require('electron');
const fetch = require('node-fetch');

const fetchNotifications = async () => {
  const url = process.env.BRUNO_INFO_ENDPOINT || 'https://appinfo.usebruno.com';
  const data = await fetch(url).then((res) => res.json());
  return data?.notifications || [];
};

// narado (its desktop app, or a person's worker on the server) doesn't show Bruno's
// announcements, and doesn't contact Bruno's server for them.
const isNarado = () => process.env.NARADO_DESKTOP === '1' || !!process.env.NARADO_WORKER_SECRET;

const pushNotifications = async (mainWindow) => {
  if (isNarado()) return mainWindow.webContents.send('main:load-notifications', []);
  try {
    const notifications = await fetchNotifications();
    mainWindow.webContents.send('main:load-notifications', notifications);
  } catch (error) {
    console.error('Error while fetching notifications!', error);
  }
};

const registerNotificationsIpc = (mainWindow, watcher) => {
  mainWindow.webContents.on('did-finish-load', () => pushNotifications(mainWindow));
  ipcMain.on('renderer:notifications-opened', () => pushNotifications(mainWindow));
};

module.exports = registerNotificationsIpc;
