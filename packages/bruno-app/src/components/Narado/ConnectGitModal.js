import { IconGitBranch, IconGitPullRequest, IconShieldLock } from '@tabler/icons';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { connectGitAccount } from './api';

/**
 * After sign-in, when no Git account is connected: what connecting does and why, before
 * the person is sent to GitHub or GitLab. Offered once per browser session; "Not now" is
 * respected, and the Git section's empty state offers it again.
 */
const ConnectGitModal = ({ host, onClose }) => {
  const name = host.name || (host.id === 'gitlab' ? 'GitLab' : 'GitHub');
  const points = [
    [IconGitBranch, 'Open your team’s repositories', `Browse the API collections and OpenAPI specs in ${name} and work on them here.`],
    [IconGitPullRequest, 'Propose changes as yourself', 'Edits become a branch and a pull request under your own name, reviewed like any other change.'],
    [IconShieldLock, 'Only what you can already see', `narado acts as you, with your ${name} permissions. You can disconnect at any time.`]
  ];
  return (
    <Modal size="md" title={`Connect your ${name} account`} hideFooter handleCancel={onClose} dataTestId="narado-connect-git">
      <div className="flex flex-col gap-4 text-sm">
        <div className="opacity-80">narado works with your team’s API collections where they live: in Git. Connect your account to get started.</div>
        <ul className="flex flex-col gap-3" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {points.map(([Icon, title, text]) => (
            <li key={title} className="flex gap-3">
              <span
                aria-hidden="true"
                style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(251,155,26,.12)', color: '#FB9B1A' }}
              >
                <Icon size={16} stroke={1.75} />
              </span>
              <span>
                <span className="font-medium" style={{ display: 'block' }}>
                  {title}
                </span>
                <span className="opacity-70">{text}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-end gap-2" style={{ marginTop: 4 }}>
          <Button size="sm" variant="ghost" color="secondary" onClick={onClose} data-testid="narado-connect-git-later">
            Not now
          </Button>
          <Button size="sm" onClick={() => connectGitAccount(host)} data-testid="narado-connect-git-go">
            Connect {name}
          </Button>
        </div>
        <div className="opacity-60" style={{ fontSize: 12 }}>
          You’ll confirm on {name}, then come straight back here.
        </div>
      </div>
    </Modal>
  );
};

export default ConnectGitModal;
