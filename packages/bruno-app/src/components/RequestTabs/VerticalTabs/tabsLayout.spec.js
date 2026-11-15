import { renderHook, act } from '@testing-library/react';
import { setVerticalTabs, setVerticalTabsCollapsed, setVerticalTabsWidth, useTabsLayout, VERTICAL_DEFAULT, VERTICAL_MAX, VERTICAL_MIN } from '../tabsLayout';

describe('tab layout setting', () => {
  beforeEach(() => window.localStorage.clear());

  it('starts with tabs along the top', () => {
    const { result } = renderHook(() => useTabsLayout());
    expect(result.current).toEqual({ vertical: false, collapsed: false, width: VERTICAL_DEFAULT });
  });

  it('switches every user of the setting at once, and remembers it', () => {
    const a = renderHook(() => useTabsLayout());
    const b = renderHook(() => useTabsLayout());
    act(() => setVerticalTabs(true));
    act(() => setVerticalTabsCollapsed(true));
    expect(a.result.current.vertical).toBe(true);
    expect(b.result.current.collapsed).toBe(true);
    expect(renderHook(() => useTabsLayout()).result.current.vertical).toBe(true);
  });

  it('keeps the width between its limits', () => {
    const { result } = renderHook(() => useTabsLayout());
    act(() => setVerticalTabsWidth(5000));
    expect(result.current.width).toBe(VERTICAL_MAX);
    act(() => setVerticalTabsWidth(10));
    expect(result.current.width).toBe(VERTICAL_MIN);
  });

  it('works when storage is unavailable', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTabsLayout());
    expect(result.current.vertical).toBe(false);
    spy.mockRestore();
  });
});
