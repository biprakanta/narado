import { pathForDir } from '../focusCollection';

describe('pathForDir', () => {
  const opened = ['/views/acme/api/worktrees/main', '/views/acme/api/worktrees/main/services/orders/api', '/git/acme/api/worktrees/main/tools/smoke'];
  it('finds the opened folder for a collection in the repository', () => {
    expect(pathForDir(opened, 'services/orders/api')).toBe(opened[1]);
    expect(pathForDir(opened, 'tools/smoke')).toBe(opened[2]);
    expect(pathForDir(opened, '')).toBe(opened[0]);
    expect(pathForDir(opened, 'missing')).toBe(null);
    expect(pathForDir([], '')).toBe(null);
  });
});
