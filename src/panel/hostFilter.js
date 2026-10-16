// Host 过滤：example.com 匹配自身及所有子域；含 * 时按通配符整体匹配，如 *.example.com、api-*.example.org
export const DEFAULT_RULE = { mode: 'all', patterns: [] };

const toMatcher = (pattern) => {
  const p = pattern.trim().toLowerCase();
  if (!p.includes('*')) return (host) => host === p || host.endsWith(`.${p}`);
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (host) => re.test(host);
};

export function compileRule(rule) {
  const matchers = rule.patterns.filter(Boolean).map(toMatcher);
  if (rule.mode === 'all' || !matchers.length) return () => true;
  const hit = (host) => matchers.some((m) => m(host));
  return rule.mode === 'include' ? hit : (host) => !hit(host);
}
