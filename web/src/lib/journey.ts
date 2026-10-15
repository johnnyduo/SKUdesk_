// The story of the product in six steps, in the order a visitor should see it. One list drives the sidebar, the top-bar "Next" button,
// the strip at the bottom of every page, and the links on /show and /market, so the order can never drift between pages.
export type JourneyStep = { n: number; href: string; label: string; blurb: string; tabs?: [href: string, label: string][]; matches: string[] };
export const JOURNEY: JourneyStep[] = [
  { n: 1, href: '/app/', label: 'Desk', blurb: 'Start here: run a check, see the opportunities and the decisions waiting for you.', matches: ['/app', '/app/opportunities', '/app/lots', '/app/transactions', '/app/radar', '/app/orders'],
    tabs: [['/app/', 'Overview'], ['/app/opportunities/', 'Opportunities'], ['/app/lots/', 'Lots'], ['/app/transactions/', 'Decisions'], ['/app/radar/', 'Radar'], ['/app/orders/', 'Approvals']] },
  { n: 2, href: '/show/', label: 'Agent decision', blurb: 'Watch the agent work through one real check, step by step.', matches: ['/show'] },
  { n: 3, href: '/market/', label: 'Offer market', blurb: 'Every product the agent tracks, with the ladder of identical offers and its price history.', matches: ['/market'] },
  { n: 4, href: '/app/create/', label: 'Deploy agent', blurb: 'Put a product on the watchlist so the agent checks it every day.', matches: ['/app/create'] },
  { n: 5, href: '/app/agent/', label: 'Limits', blurb: 'What the agent may do, the owner’s limits and the kill switch.', matches: ['/app/agent', '/app/policies', '/app/owner'],
    tabs: [['/app/agent/', 'Agent'], ['/app/policies/', 'Limits'], ['/app/owner/', 'Owner console']] },
  { n: 6, href: '/app/analytics/', label: 'Proof', blurb: 'Run metrics, the evaluation results and what the service depends on.', matches: ['/app/analytics', '/app/deploy', '/app/integrations'],
    tabs: [['/app/analytics/', 'Run metrics'], ['/app/deploy/', 'Deployment'], ['/app/integrations/', 'Dependencies']] },
];
const norm = (p: string) => (p.replace(/\/$/, '') || '/');
const under = (p: string, h: string) => p === h || p.startsWith(h + '/');
/** The step a path belongs to. The longest matching prefix wins, so /app/create is step 4 and not part of the desk at /app. */
export function stepOf(path: string): JourneyStep | undefined {
  const p = norm(path); let best: JourneyStep | undefined; let len = -1;
  for (const s of JOURNEY) for (const m of s.matches) if ((m === '/app' ? p === '/app' : under(p, m)) && m.length > len) { best = s; len = m.length; }
  return best;
}
export const nextOf = (s: JourneyStep) => JOURNEY[s.n] as JourneyStep | undefined;
export const prevOf = (s: JourneyStep) => JOURNEY[s.n - 2] as JourneyStep | undefined;
