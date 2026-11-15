import React from 'react';
import { render } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { Provider } from 'react-redux';
import themes from 'themes/index';

/** A fake server: `routes[channel](payload, ...rest)` answers window.ipcRenderer.invoke. */
export const fakeServer = (routes) => {
  const calls = [];
  window.ipcRenderer = {
    invoke: jest.fn(async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (!routes[channel]) throw new Error(`Error invoking remote method '${channel}': Error: no route`);
      return routes[channel](...args);
    }),
    on: () => () => {}
  };
  window.isBrunoWeb = true;
  return calls;
};

const fakeStore = () => ({
  getState: () => ({ collections: { collections: [] }, app: {}, tabs: { tabs: [] } }),
  dispatch: jest.fn(),
  subscribe: () => () => {}
});

export const renderWithApp = (ui) =>
  render(
    <Provider store={fakeStore()}>
      <ThemeProvider theme={themes.dark}>{ui}</ThemeProvider>
    </Provider>
  );
