import { friendlyPath } from '../paths';

describe('friendlyPath', () => {
  const web = { web: true };
  it('says which repository, branch and folder a working copy is', () => {
    expect(friendlyPath('/data/users/6764a549/git/github/acme/payments/worktrees/narado__alice__refunds/api', web)).toBe('github · acme/payments · narado/alice/refunds · api');
    expect(friendlyPath('/data/users/6764a549/views/gitlab/acme/orders/worktrees/main', web)).toBe('gitlab · acme/orders · main');
  });
  it('names synced copies and personal collections', () => {
    expect(friendlyPath('/data/users/u1/synced/github/acme%2Forders/api', web)).toBe('Synced from github · acme/orders/api');
    expect(friendlyPath('/data/users/u1/synced/github/acme%2Forders/_root', web)).toBe('Synced from github · acme/orders');
    expect(friendlyPath('/data/users/u1/collections/bruno/Sample API Collection', web)).toBe('Your collections · Sample API Collection');
  });
  it('leaves real paths alone on the desktop and outside narado data folders', () => {
    expect(friendlyPath('/Users/alice/api/payments', { web: false })).toBe('/Users/alice/api/payments');
    expect(friendlyPath('/srv/other/place', web)).toBe('/srv/other/place');
  });
});
