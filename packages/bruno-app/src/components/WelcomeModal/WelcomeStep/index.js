import React from 'react';
import {
  IconFolder as IconFolderTabler,
  IconGitFork,
  IconLock,
  IconRocket
} from '@tabler/icons';
import StyledWrapper from './StyledWrapper';
import { isNarado } from 'utils/common/product';

// narado (the web build) runs on a server, so Bruno's offline and local-disk claims don't apply.
const naradoHighlights = [
  {
    icon: IconGitFork,
    title: 'Stored in Git',
    desc: 'Collections live in your team\'s GitHub or GitLab repositories, as OpenAPI specs and plain files.'
  },
  {
    icon: IconFolderTabler,
    title: 'Changes through review',
    desc: 'Edits become a branch or fork and a merge request. Nothing is pushed straight to main.'
  },
  {
    icon: IconLock,
    title: 'Your company sign-in',
    desc: 'Sign in with your organisation\'s single sign-on. Secrets are masked wherever narado shows them.'
  },
  {
    icon: IconRocket,
    title: 'Ready for AI assistants',
    desc: 'Assistants can read and send requests through narado\'s MCP server, acting as you.'
  }
];

const brunoHighlights = [
  {
    icon: IconFolderTabler,
    title: 'Filesystem only',
    desc: 'Collections are plain files on your disk. No cloud sync, no proprietary lock-in.'
  },
  {
    icon: IconGitFork,
    title: 'Git-friendly',
    desc: 'Every request is a readable file. Commit, branch, review, and collaborate using the tools you already know.'
  },
  {
    icon: IconLock,
    title: 'Privacy-focused',
    desc: 'No account, no login. Bruno works entirely offline, your API keys never leave your machine.'
  },
  {
    icon: IconRocket,
    title: 'Fast and lightweight',
    desc: 'Built to be snappy. No bloated runtimes, just a fast, focused tool for exploring and testing APIs.'
  }
];

const WelcomeStep = () => (
  <StyledWrapper className="step-body">
    <div className="highlights">
      {(isNarado() ? naradoHighlights : brunoHighlights).map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.title} className="highlight-item">
            <div className="highlight-icon">
              <Icon size={18} stroke={1.5} />
            </div>
            <div>
              <div className="highlight-title">{item.title}</div>
              <div className="highlight-desc">{item.desc}</div>
            </div>
          </div>
        );
      })}
    </div>
  </StyledWrapper>
);

export default WelcomeStep;
