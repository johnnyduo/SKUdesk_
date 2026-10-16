// Products with a 3D model. They are previews: no price is shown until a real check has run on them.
// `model` is the 3D model the viewer builds (the key of its spec); `query` is what a check on the desk starts from.
export type Device = { symbol: string; model: string; name: string; category: string; art: string; query: string; sub?: string };

export const DEVICES: Device[] = [
  { symbol: 'IP16P-CLR', model: 'IP16P-CLR', name: 'iPhone 16 Pro Clear MagSafe Case', category: 'Accessories', art: '/img/cases/iphone-16-pro_clear_mag_1.svg', query: 'iPhone 16 Pro Clear MagSafe Case', sub: 'Clear MagSafe case for iPhone 16 Pro' },
  { symbol: 'APP2', model: 'APP3', name: 'AirPods Pro 2', category: 'Audio', art: '/img/showcase/earbuds.svg', query: 'Apple AirPods Pro 2 USB-C' },
  { symbol: 'IP16PM', model: 'IP18P', name: 'iPhone 16 Pro Max (256 GB)', category: 'Phones', art: '/img/showcase/phone-pro.svg', query: 'Apple iPhone 16 Pro Max 256GB' },
  { symbol: 'NSWO', model: 'NSW2', name: 'Nintendo Switch OLED', category: 'Gaming', art: '/img/showcase/handheld.svg', query: 'Nintendo Switch OLED' },
  { symbol: 'MBA13', model: 'MBA13', name: 'MacBook Air 13 M3 (16/512)', category: 'Computing', art: '/img/showcase/laptop.svg', query: 'Apple MacBook Air 13 M3 16GB 512GB' },
  { symbol: 'AW10', model: 'AW12', name: 'Apple Watch Series 10 (42 mm)', category: 'Wearables', art: '/img/showcase/watch.svg', query: 'Apple Watch Series 10 42mm' },
  { symbol: 'S25', model: 'S26', name: 'Galaxy S25 (256 GB)', category: 'Phones', art: '/img/showcase/phone-flat.svg', query: 'Samsung Galaxy S25 256GB' },
  { symbol: 'PS5', model: 'PS5', name: 'PlayStation 5 (disc, 1 TB)', category: 'Gaming', art: '/img/showcase/console.svg', query: 'Sony PlayStation 5 Slim Disc Edition 1TB' },
];

export const deviceLine = (d: Device): string => `${d.category} · 3D preview`;

/** The 3D model that stands for a checked product: an exact match with a preview's query, or any iPhone, Pixel or Galaxy by name. */
export function deviceForQuery(query: string): Device | undefined {
  const q = query.trim().toLowerCase();
  const exact = DEVICES.find((d) => d.query.toLowerCase() === q);
  if (exact) return exact;
  if (/\biphone\b/.test(q) && !/case|cover|protector/.test(q)) return DEVICES.find((d) => d.symbol === 'IP16PM');
  if (/\b(pixel|galaxy)\b/.test(q) && !/case|cover|protector/.test(q)) return DEVICES.find((d) => d.symbol === 'S25');
  return undefined;
}
