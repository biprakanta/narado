import { useEffect, useState } from 'react';

/**
 * Where request tabs are shown: along the top (Bruno's horizontal strip) or as a vertical
 * list beside the request, like Chrome's vertical tabs. A per-person view setting, kept in
 * this browser (or app) only.
 */
const LAYOUT_KEY = 'narado.tabs-layout';
const COLLAPSED_KEY = 'narado.vertical-tabs-collapsed';
const WIDTH_KEY = 'narado.vertical-tabs-width';
const EVENT = 'narado:tabs-layout';

export const VERTICAL_MIN = 160;
export const VERTICAL_MAX = 420;
export const VERTICAL_DEFAULT = 232;

const read = (key, fallback) => {
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
};

const write = (key, value) => {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT));
};

const current = () => {
  const width = Number(read(WIDTH_KEY, VERTICAL_DEFAULT));
  return {
    vertical: read(LAYOUT_KEY, 'horizontal') === 'vertical',
    collapsed: read(COLLAPSED_KEY, '0') === '1',
    width: Number.isFinite(width) ? Math.min(VERTICAL_MAX, Math.max(VERTICAL_MIN, width)) : VERTICAL_DEFAULT
  };
};

export const setVerticalTabs = (on) => write(LAYOUT_KEY, on ? 'vertical' : 'horizontal');
export const setVerticalTabsCollapsed = (on) => write(COLLAPSED_KEY, on ? '1' : '0');
export const setVerticalTabsWidth = (px) => write(WIDTH_KEY, Math.round(Math.min(VERTICAL_MAX, Math.max(VERTICAL_MIN, px))));

/** { vertical, collapsed, width }, kept in step across components. */
export const useTabsLayout = () => {
  const [state, setState] = useState(current);
  useEffect(() => {
    const update = () => setState(current());
    window.addEventListener(EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return state;
};
