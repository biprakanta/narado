import styled from 'styled-components';

const StyledWrapper = styled.aside`
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid ${(props) => props.theme.requestTabs.bottomBorder};
  background: ${(props) => props.theme.bg};

  .vertical-tabs-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 6px 4px 8px;
    min-height: 34px;
  }

  .vertical-tabs-title {
    flex: 1;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors?.text?.muted || props.theme.requestTabs.color};
    opacity: 0.75;
    white-space: nowrap;
  }

  .vertical-tabs-new {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 6px 4px;
    padding: 2px 4px;
    border-radius: ${(props) => props.theme.border.radius.base};
    font-size: 0.8125rem;
    color: ${(props) => props.theme.requestTabs.color};

    &:hover {
      background: ${(props) => props.theme.requestTabs.bg};
    }
  }

  .vertical-tabs-new-label {
    opacity: 0.8;
    pointer-events: none;
  }

  .vertical-tabs-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0 6px 8px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  li.request-tab {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 30px;
    padding: 4px 6px 4px 8px;
    border-radius: ${(props) => props.theme.border.radius.base};
    border: 1px solid transparent;
    cursor: pointer;
    font-size: 0.8125rem;
    color: ${(props) => props.theme.requestTabs.color};
    background: transparent;
    position: relative;

    .tab-container {
      width: 100%;
      position: relative;
      overflow: hidden;
    }

    &:hover {
      background: ${(props) => props.theme.requestTabs.bg};
    }

    &.active {
      background: ${(props) => props.theme.requestTabs.bg};
      border-color: ${(props) => props.theme.requestTabs.bottomBorder};
      font-weight: 500;

      /* A brand bar on the left edge marks the active request. */
      &::before {
        content: '';
        position: absolute;
        left: -1px;
        top: 6px;
        bottom: 6px;
        width: 3px;
        border-radius: 0 3px 3px 0;
        background: ${(props) => props.theme.primary?.solid || props.theme.brand || '#fd6e15'};
      }
    }

    /* The close button's fade matches each row's own background here. */
    .close-gradient {
      background-image: linear-gradient(90deg, transparent 0%, ${(props) => props.theme.bg} 40%) !important;
    }

    &:hover .close-gradient,
    &.active .close-gradient {
      background-image: linear-gradient(90deg, transparent 0%, ${(props) => props.theme.requestTabs.bg} 40%) !important;
    }

    &.has-overflow:not(:hover) .tab-name {
      mask-image: linear-gradient(to right, #000 0%, #000 calc(100% - 12px), transparent 100%);
      -webkit-mask-image: linear-gradient(to right, #000 0%, #000 calc(100% - 12px), transparent 100%);
    }
  }

  .vertical-tabs-resize {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 2;

    &:hover {
      background: ${(props) => props.theme.requestTabs.bottomBorder};
      opacity: 0.6;
    }
  }

  /* Collapsed: a narrow strip that shows each request's method only. */
  &.collapsed {
    .vertical-tabs-header {
      justify-content: center;
      padding: 6px 0 4px;
    }

    .vertical-tabs-new {
      justify-content: center;
      margin: 0 4px 4px;
      padding: 2px 0;
    }

    .vertical-tabs-scroll {
      padding: 0 4px 8px;
    }

    li.request-tab {
      justify-content: center;
      padding: 4px 2px;
    }

    li.request-tab {
      min-height: 32px;
      opacity: 0.85;

      &:hover,
      &.active {
        opacity: 1;
      }
    }

    .collapsed-tab {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 22px;
    }

    .collapsed-draft {
      position: absolute;
      top: 0;
      right: 6px;
      width: 6px;
      height: 6px;
      box-shadow: 0 0 0 2px ${(props) => props.theme.bg};
      border-radius: 50%;
      background: ${(props) => props.theme.draftColor || '#cc7b1b'};
    }
  }
`;

export default StyledWrapper;
