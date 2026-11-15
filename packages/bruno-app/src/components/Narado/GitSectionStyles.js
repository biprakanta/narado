import styled from 'styled-components';
import sidebarRowStyles from 'components/Sidebar/SidebarRowStyles';

/** Rows in the Git section, matching Bruno's own sidebar rows. */
const GitSectionStyles = styled.div`
  .narado-group {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.5rem 0.75rem 0.15rem 0.75rem;
    opacity: 0.55;
    user-select: none;
  }

  .narado-row {
    ${sidebarRowStyles({ selectedClass: 'narado-row-selected', keyboardFocusedClass: 'narado-row-focused', actionsClass: 'narado-row-actions' })}
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.5rem 0 0.6rem;
    width: 100%;
    text-align: left;
    font-size: 0.8125rem;
  }

  .narado-row-icon {
    flex-shrink: 0;
    opacity: 0.6;
  }

  .narado-row-name {
    flex: 1 1 auto;
    min-width: 3rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .narado-row-meta {
    flex: 0 100 auto;
    min-width: 0;
    max-width: 35%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.6875rem;
    opacity: 0.55;
  }

  .narado-row-actions {
    flex-shrink: 0;
  }

  .narado-empty {
    padding: 0.35rem 0.75rem;
    font-size: 0.75rem;
    opacity: 0.7;
    text-align: left;
  }
  .narado-empty:hover {
    opacity: 1;
    text-decoration: underline;
  }

  .narado-empty-state {
    margin: 4px 8px 8px;
    padding: 12px;
    border-radius: 8px;
    border: 1px dashed ${(props) => props.theme.border?.border1 || 'rgba(127,127,127,.3)'};
  }
  .narado-empty-title {
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .narado-empty-text {
    margin-top: 4px;
    font-size: 0.75rem;
    line-height: 1.45;
    opacity: 0.7;
  }
  .narado-empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .narado-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 10px;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid ${(props) => props.theme.border?.border1 || 'rgba(127,127,127,.3)'};
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .narado-btn:hover {
    background: ${(props) => props.theme.sidebar?.collection?.item?.hoverBg || 'rgba(127,127,127,.12)'};
  }
  .narado-btn-primary {
    border-color: transparent;
    color: #1b1205;
    background: ${(props) => props.theme.brand || '#FB9B1A'};
  }
  .narado-btn-primary:hover {
    background: ${(props) => props.theme.brand || '#FB9B1A'};
    filter: brightness(1.06);
  }
  .narado-btn:focus-visible {
    outline: 2px solid ${(props) => props.theme.brand || '#FB9B1A'};
    outline-offset: 1px;
  }

  .narado-offline {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 8px 4px;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors?.text?.warning || '#e8590c'};
    background: ${(props) => props.theme.requestTabs?.bg || 'transparent'};
    cursor: default;
  }

  .narado-update {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 8px 4px;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 0.75rem;
    text-align: left;
    color: ${(props) => props.theme.brand || '#FB9B1A'};
    background: ${(props) => props.theme.requestTabs?.bg || 'transparent'};
    border: 0;
    cursor: pointer;

    &:disabled {
      cursor: default;
      opacity: 0.85;
    }
  }
`;

export default GitSectionStyles;
