import { $, api, h, money, reduceMotion } from './client.ts';
import { renderAnalysis } from './analysis-view.ts';
import { createRunPanel, streamAnalysis } from './run-panel.ts';

// The check form with its live run panel and result. Used on the desk overview and anywhere a check can be started.
export async function mountDesk(root: HTMLElement, opts: { onDone?: (a: any) => void } = {}): Promise<{ run(query: string, market: string): Promise<void> }> {
  const st = await api('/api/status').catch(() => null);
  const markets: { code: string; label: string; currency: string }[] = st?.markets ?? [{ code: 'us', label: 'United States', currency: 'USD' }];
  const picks: { query: string; market: string }[] = st?.watchlist?.length ? st.watchlist : [{ query: 'LEGO 10294 Titanic', market: 'us' }];

  const input = h('input', { id: 'query', name: 'query', required: true, minlength: 3, maxlength: 80, placeholder: 'LEGO 10294 Titanic', spellcheck: 'false' });
  const select = h('select', { id: 'market', name: 'market' }, markets.map((m) => h('option', { value: m.code }, `${m.label} (${m.currency})`)));
  const go = h('button', { class: 'btn lg', type: 'submit' }, 'Check');
  const wanted = new URLSearchParams(location.search).get('q');
  if (wanted && wanted.length <= 80) input.value = wanted;
  const form = h('form', { class: 'ask card formrow', autocomplete: 'off' },
    h('div', { class: 'field grow' }, h('label', { class: 'label', for: 'query' }, 'Product, with its set or model number'), input),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'market' }, 'Market'), select), go);
  const examples = h('div', { class: 'examples' }, h('span', { class: 'muted sm' }, 'Try:'),
    picks.map((w) => h('button', { type: 'button', on: { click: () => { input.value = w.query; select.value = w.market; form.requestSubmit(); } } }, w.query)));
  const slot = h('div', {});
  root.replaceChildren(form, examples, slot);

  const run = async (query: string, market: string): Promise<void> => {
    go.disabled = true;
    const panel = createRunPanel();
    slot.replaceChildren(panel.el);
    panel.start();
    try {
      const a = await streamAnalysis(query, market, (ev) => panel.handle(ev));
      panel.finish();
      const view = renderAnalysis(a);
      slot.replaceChildren(view);
      view.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
      opts.onDone?.(a);
    } catch (e) {
      slot.replaceChildren(h('div', { class: 'alert', role: 'alert' }, (e as Error).message));
    } finally {
      go.disabled = false;
    }
  };
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void run(input.value.trim(), select.value); });
  return { run };
}

export const feed = (events: any[]): HTMLElement => h('ol', { class: 'feed' }, events.map((e) => h('li', {},
  h('span', { class: 't' }, new Date(e.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })),
  h('span', { class: `pill ${e.kind === 'decision' ? 'good' : e.kind === 'owner' ? 'warn' : e.kind === 'scan' ? 'blue' : ''}` }, e.kind),
  h('div', { class: 'd' }, h('span', {}, e.title), e.detail ? h('small', {}, e.detail) : null))));

export { $, money };
