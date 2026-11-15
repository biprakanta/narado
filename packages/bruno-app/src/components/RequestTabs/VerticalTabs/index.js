import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import classnames from 'classnames';
import { useDispatch, useSelector } from 'react-redux';
import { get } from 'lodash';
import {
  IconAlertTriangle,
  IconBrandGraphql,
  IconCode,
  IconLayoutNavbar,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPlugConnected,
  IconSettings,
  IconWorld
} from '@tabler/icons';
import ToolHint from 'components/ToolHint';
import useTooltipId from 'hooks/useTooltipId';
import { useTheme } from 'providers/Theme';
import { findItemInCollection, findItemInCollectionByPathname, hasRequestChanges } from 'utils/collections';
import { focusTab, reorderTabs } from 'providers/ReduxStore/slices/tabs';
import { revealTabInSidebar } from 'providers/ReduxStore/slices/collections/actions';
import CreateTransientRequest from 'components/CreateTransientRequest';
import ActionIcon from 'ui/ActionIcon/index';
import { selectCollectionByUid } from 'src/selectors/collections';
import { selectActiveTab, selectActiveTabUid, makeSelectTabsForCollection } from 'src/selectors/tab';
import DraggableTab from '../DraggableTab';
import RequestTab from '../RequestTab';
import { setVerticalTabs, setVerticalTabsCollapsed, setVerticalTabsWidth, useTabsLayout } from '../tabsLayout';
import StyledWrapper from './StyledWrapper';

const TAB_NAMES = { 'collection-settings': 'Collection settings', 'folder-settings': 'Folder settings', 'environment-settings': 'Environments', 'collection-runner': 'Runner', 'variables': 'Variables' };

// Each request type's icon (GraphQL, gRPC and WebSocket as in the New request menu); HTTP is a
// globe in its method's colour.
const TYPE_ICONS = { 'graphql-request': [IconBrandGraphql, 'gql', 'GraphQL'], 'grpc-request': [IconCode, 'grpc', 'gRPC'], 'ws-request': [IconPlugConnected, 'ws', 'WebSocket'] };

/** One tab in the collapsed strip: its request type's icon, the name in a tooltip. */
const CollapsedTab = ({ tab, collection }) => {
  const { theme } = useTheme();
  const hintId = useTooltipId('vertical-tab');
  let item = collection ? findItemInCollection(collection, tab.uid) : null;
  if (!item && collection && tab.pathname) item = findItemInCollectionByPathname(collection, tab.pathname);
  const isRequest = /request$/.test(tab.type || '') || (item && /request$/.test(item.type || ''));

  let Icon = IconSettings;
  let color;
  let label = TAB_NAMES[tab.type] || 'Settings';
  let changed = false;
  if (isRequest && !item) {
    Icon = IconAlertTriangle;
    color = theme.colors?.text?.warning || '#d97706';
    label = 'Not found: this request\'s file was deleted';
  } else if (isRequest) {
    changed = hasRequestChanges(item);
    const typed = TYPE_ICONS[item.type];
    if (typed) {
      Icon = typed[0];
      color = theme.request[typed[1]];
      label = `${typed[2]} · ${item.name}`;
    } else {
      const method = String((item.draft ? get(item, 'draft.request.method') : get(item, 'request.method')) || 'GET').toUpperCase();
      Icon = IconWorld;
      color = theme.request.methods[method.toLowerCase()];
      label = `${method} · ${item.name}`;
    }
    if (changed) label += ' (unsaved)';
  }

  return (
    <>
      <span className="collapsed-tab" id={hintId} aria-label={label}>
        <Icon size={17} strokeWidth={1.75} style={color ? { color } : undefined} aria-hidden="true" />
        {changed && <span className="collapsed-draft" aria-hidden="true" />}
      </span>
      <ToolHint toolhintId={hintId} text={label} place="right" positionStrategy="fixed" />
    </>
  );
};

/**
 * The open requests as a vertical list beside the request, like Chrome's vertical tabs:
 * full names, drag to reorder, the same tab menu (right-click) and close buttons. It can be
 * collapsed to a narrow strip of methods, resized from its edge, or put back along the top.
 */
const VerticalTabs = () => {
  const dispatch = useDispatch();
  const listRef = useRef();
  const containerRef = useRef();
  const { collapsed, width } = useTabsLayout();
  const [overflow, setOverflow] = useState({});
  const activeTabUid = useSelector(selectActiveTabUid);
  const activeTab = useSelector(selectActiveTab);
  const activeCollection = useSelector((state) => selectCollectionByUid(state, activeTab?.collectionUid));
  const selectTabsForCollection = useMemo(makeSelectTabsForCollection, []);
  const tabs = useSelector((state) => selectTabsForCollection(state, activeTab?.collectionUid));

  const setHasOverflowFor = useCallback(
    (uid) => (has) => setOverflow((prev) => (prev[uid] === has ? prev : { ...prev, [uid]: has })),
    []
  );

  // Keep the active request in view.
  useEffect(() => {
    const el = listRef.current?.querySelector('.request-tab.active');
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [activeTabUid]);

  // Resize by dragging the right edge.
  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev) => setVerticalTabsWidth(startWidth + ev.clientX - startX);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!activeTabUid || !tabs || !tabs.length) return null;

  const onClick = (tab) => {
    const already = tab.uid === activeTabUid;
    dispatch(focusTab({ uid: tab.uid }));
    if (already) dispatch(revealTabInSidebar(tab.uid));
  };

  return (
    <StyledWrapper
      className={classnames('vertical-tabs', { collapsed })}
      style={{ width: collapsed ? 48 : width }}
      ref={containerRef}
      aria-label="Open requests"
      data-testid="vertical-tabs"
    >
      <div className="vertical-tabs-header">
        <ActionIcon
          label={collapsed ? 'Expand the tab list' : 'Collapse the tab list'}
          onClick={() => setVerticalTabsCollapsed(!collapsed)}
          data-testid="vertical-tabs-collapse"
        >
          {collapsed ? <IconLayoutSidebarLeftExpand size={16} stroke={1.5} /> : <IconLayoutSidebarLeftCollapse size={16} stroke={1.5} />}
        </ActionIcon>
        {!collapsed && (
          <>
            <span className="vertical-tabs-title">
              {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
            </span>
            <ActionIcon label="Show tabs along the top" onClick={() => setVerticalTabs(false)} data-testid="vertical-tabs-off">
              <IconLayoutNavbar size={16} stroke={1.5} />
            </ActionIcon>
          </>
        )}
      </div>

      {activeCollection && (
        <div className="vertical-tabs-new" title="New request">
          <CreateTransientRequest collectionUid={activeCollection.uid} />
          {!collapsed && <span className="vertical-tabs-new-label">New request</span>}
        </div>
      )}

      <div className="vertical-tabs-scroll">
        <ul role="tablist" aria-orientation="vertical" ref={listRef}>
          {tabs.map((tab, index) => (
            <DraggableTab
              key={tab.uid}
              id={tab.uid}
              index={index}
              onMoveTab={(source, target) => dispatch(reorderTabs({ sourceUid: source, targetUid: target }))}
              className={classnames('request-tab select-none', { 'active': tab.uid === activeTabUid, 'has-overflow': overflow[tab.uid] })}
              active={tab.uid === activeTabUid}
              onClick={() => onClick(tab)}
            >
              {collapsed ? (
                <CollapsedTab tab={tab} collection={activeCollection} />
              ) : (
                <RequestTab
                  collectionRequestTabs={tabs}
                  tabIndex={index}
                  tab={tab}
                  collection={activeCollection}
                  folderUid={tab.folderUid}
                  hasOverflow={overflow[tab.uid]}
                  setHasOverflow={setHasOverflowFor(tab.uid)}
                  dropdownContainerRef={containerRef}
                />
              )}
            </DraggableTab>
          ))}
        </ul>
      </div>

      {!collapsed && <div className="vertical-tabs-resize" onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize the tab list" />}
    </StyledWrapper>
  );
};

export default VerticalTabs;
