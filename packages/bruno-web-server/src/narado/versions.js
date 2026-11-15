/** Compare versions like 1.2.3 (and 1.2.3-beta.1, ignoring the suffix): negative, zero or positive. */
const compareVersions = (a, b) => {
  const parse = (v) => String(v || '0').split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

module.exports = { compareVersions };
