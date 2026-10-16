// Reference products with a 3D model. Prices are US list prices (integer cents), not live quotes.
// A check on any of them starts from the query on the desk; these are not claims about current offers.
export type Device = { symbol: string; name: string; category: string; listCents: number; art: string; query: string; sub?: string };

export const DEVICES: Device[] = [
  { symbol: 'IP16P-CLR', name: 'iPhone 16 Pro Clear MagSafe Case', category: 'Accessories', listCents: 4900, art: '/img/cases/iphone-16-pro_clear_mag_1.svg', query: 'iPhone 16 Pro Clear MagSafe Case', sub: 'Clear MagSafe case for iPhone 16 Pro' },
  { symbol: 'APP3', name: 'AirPods Pro 3', category: 'Audio', listCents: 24900, art: '/img/showcase/earbuds.svg', query: 'AirPods Pro 3' },
  { symbol: 'IP18P', name: 'iPhone 18 Pro (256 GB)', category: 'Phones', listCents: 119900, art: '/img/showcase/phone-pro.svg', query: 'iPhone 18 Pro 256GB' },
  { symbol: 'NSW2', name: 'Nintendo Switch 2', category: 'Gaming', listCents: 49999, art: '/img/showcase/handheld.svg', query: 'Nintendo Switch 2' },
  { symbol: 'MBA13', name: 'MacBook Air 13 M5 (16/512)', category: 'Computing', listCents: 129900, art: '/img/showcase/laptop.svg', query: 'MacBook Air 13 M5 16GB 512GB' },
  { symbol: 'AW12', name: 'Apple Watch Series 12 (42 mm)', category: 'Wearables', listCents: 39900, art: '/img/showcase/watch.svg', query: 'Apple Watch Series 12 42mm' },
  { symbol: 'S26', name: 'Galaxy S26 (256 GB)', category: 'Phones', listCents: 99999, art: '/img/showcase/phone-flat.svg', query: 'Galaxy S26 256GB' },
  { symbol: 'PS5', name: 'PlayStation 5 (disc, 1 TB)', category: 'Gaming', listCents: 64999, art: '/img/showcase/console.svg', query: 'PlayStation 5 disc 1TB' },
];

export const deviceLine = (d: Device, fmt: (cents: number) => string): string => `${d.category} · US list price ${fmt(d.listCents)}`;
