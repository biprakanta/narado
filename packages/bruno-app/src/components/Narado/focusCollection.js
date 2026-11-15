import { toggleCollection } from 'providers/ReduxStore/slices/collections';
import { mountCollection } from 'providers/ReduxStore/slices/collections/actions';
import { addTab } from 'providers/ReduxStore/slices/tabs';
import { setFocusedSidebarPath } from 'providers/ReduxStore/slices/app';

/** Of the folders a repo opened, the one for a collection at `dir` in the repo ('' for its root). */
export const pathForDir = (paths, dir) => {
  if (!paths || !paths.length) return null;
  if (dir) return paths.find((p) => p.replace(/\\/g, '/').endsWith(`/${dir}`)) || null;
  return [...paths].sort((a, b) => a.length - b.length)[0];
};

/**
 * Show an opened collection: expand it in the sidebar and open its overview, as clicking
 * it would. Collections appear in the store shortly after the server opens them, so this
 * waits a few seconds for it.
 */
export const focusCollection = async (store, pathname, { timeoutMs = 8000 } = {}) => {
  const started = Date.now();
  let collection = null;
  while (!collection && Date.now() - started < timeoutMs) {
    collection = (store.getState().collections.collections || []).find((c) => c.pathname === pathname);
    if (!collection) await new Promise((r) => setTimeout(r, 200));
  }
  if (!collection) return false;
  const { dispatch } = store;
  if (collection.mountStatus !== 'mounted' && collection.mountStatus !== 'mounting') {
    dispatch(mountCollection({ collectionUid: collection.uid, collectionPathname: collection.pathname, brunoConfig: collection.brunoConfig }));
  }
  if (collection.collapsed) dispatch(toggleCollection(collection.uid));
  dispatch(addTab({ uid: collection.uid, collectionUid: collection.uid, type: 'collection-settings' }));
  dispatch(setFocusedSidebarPath(collection.pathname));
  return true;
};
