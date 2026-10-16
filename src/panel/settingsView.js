import { $, settings } from './util.js';
import { DEFAULT_RULE } from './hostFilter.js';

export const DEFAULT_CONFIG = { hostFilter: DEFAULT_RULE, extractHeaders: ['x-tt-logid'] };

const lines = (text) => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

export async function loadConfig() {
  const [hostFilter, extractHeaders] = await Promise.all([
    settings.get('hostFilter', DEFAULT_CONFIG.hostFilter),
    settings.get('extractHeaders', DEFAULT_CONFIG.extractHeaders),
  ]);
  return { hostFilter: { ...DEFAULT_RULE, ...hostFilter }, extractHeaders };
}

export async function saveConfig(config) {
  await Promise.all([
    settings.set('hostFilter', config.hostFilter),
    settings.set('extractHeaders', config.extractHeaders),
  ]);
}

export function createSettings(root, { onSave }) {
  const hostArea = $('[data-field="hosts"]', root);
  const headerArea = $('[data-field="headers"]', root);
  const close = () => { root.hidden = true; };

  const save = async () => {
    const config = {
      hostFilter: {
        mode: $('input[name="hf-mode"]:checked', root)?.value || 'all',
        patterns: lines(hostArea.value),
      },
      extractHeaders: [...new Set(lines(headerArea.value).map((s) => s.toLowerCase()))],
    };
    await saveConfig(config);
    onSave(config);
    close();
  };

  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.closest('[data-act="cancel"]')) close();
    if (e.target.closest('[data-act="save"]')) save();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
  });

  return {
    open(config) {
      root.querySelectorAll('input[name="hf-mode"]').forEach((r) => { r.checked = r.value === config.hostFilter.mode; });
      hostArea.value = config.hostFilter.patterns.join('\n');
      headerArea.value = config.extractHeaders.join('\n');
      root.hidden = false;
      headerArea.focus();
    },
  };
}
