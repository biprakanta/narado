import '@testing-library/jest-dom';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import ServerFileDialog from '../ServerFileDialog';
import { fakeServer, renderWithApp } from './helpers';

const tree = {
  '/home/me': { parent: '/home', entries: [{ name: 'collections', dir: true }, { name: 'api.yaml', dir: false }, { name: 'notes.txt', dir: false }] },
  '/home/me/collections': { parent: '/home/me', entries: [{ name: 'petstore', dir: true }] }
};
const server = () =>
  fakeServer({
    'narado:list-folder': ({ path }) => {
      const p = path || '/home/me';
      if (!tree[p]) throw new Error('Error invoking remote method \'narado:list-folder\': Error: That folder is outside your space on the server');
      return { path: p, root: '/', truncated: false, ...tree[p] };
    }
  });

describe('Server file dialog', () => {
  it('browses into a folder and chooses it', async () => {
    const calls = server();
    const onDone = jest.fn();
    renderWithApp(<ServerFileDialog request={{ kind: 'open', properties: ['openDirectory'] }} onDone={onDone} />);
    fireEvent.click(await screen.findByTestId('narado-file-dialog-entry-collections'));
    expect(await screen.findByTestId('narado-file-dialog-entry-petstore')).toBeInTheDocument();
    expect(screen.getByTestId('narado-file-dialog-path')).toHaveValue('/home/me/collections');
    fireEvent.click(screen.getByText('Choose this folder'));
    expect(onDone).toHaveBeenCalledWith({ canceled: false, filePaths: ['/home/me/collections'] });
    expect(calls.map(([c, a]) => [c, a.path])).toEqual([['narado:list-folder', ''], ['narado:list-folder', '/home/me/collections']]);
  });

  it('opens a file, showing only those the filters allow', async () => {
    server();
    const onDone = jest.fn();
    renderWithApp(
      <ServerFileDialog request={{ kind: 'open', properties: ['openFile'], filters: [{ name: 'OpenAPI', extensions: ['yaml', 'json'] }] }} onDone={onDone} />
    );
    fireEvent.click(await screen.findByTestId('narado-file-dialog-entry-api.yaml'));
    expect(screen.queryByTestId('narado-file-dialog-entry-notes.txt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Open'));
    expect(onDone).toHaveBeenCalledWith({ canceled: false, filePaths: ['/home/me/api.yaml'] });
  });

  it('saves under a name in the folder being shown', async () => {
    server();
    const onDone = jest.fn();
    renderWithApp(<ServerFileDialog request={{ kind: 'save', defaultPath: '/home/me/export.json' }} onDone={onDone} />);
    expect(await screen.findByTestId('narado-file-dialog-name')).toHaveValue('export.json');
    await screen.findByTestId('narado-file-dialog-entry-collections');
    fireEvent.click(screen.getByText('Save'));
    expect(onDone).toHaveBeenCalledWith({ canceled: false, filePath: '/home/me/export.json' });
  });

  it('shows why a folder can\'t be opened, and goes up', async () => {
    server();
    renderWithApp(<ServerFileDialog request={{ kind: 'open', properties: ['openDirectory'] }} onDone={() => {}} />);
    await screen.findByTestId('narado-file-dialog-entry-collections');
    const input = screen.getByTestId('narado-file-dialog-path');
    fireEvent.change(input, { target: { value: '/etc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByTestId('narado-file-dialog-error')).toHaveTextContent('That folder is outside your space on the server');

    fireEvent.click(await screen.findByTestId('narado-file-dialog-entry-collections'));
    await screen.findByTestId('narado-file-dialog-entry-petstore');
    fireEvent.click(screen.getByTestId('narado-file-dialog-up'));
    await waitFor(() => expect(screen.getByTestId('narado-file-dialog-path')).toHaveValue('/home/me'));
  });
});
