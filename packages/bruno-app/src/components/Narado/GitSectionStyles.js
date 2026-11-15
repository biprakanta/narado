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
`;

export default GitSectionStyles;
