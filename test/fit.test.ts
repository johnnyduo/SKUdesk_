import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILL, coverage, fitDistance } from '../web/src/lib/fit.ts';

const shapes = [{ hgt: 1.6, wid: 0.8 }, { hgt: 1.6, wid: 1.6 }, { hgt: 1.15, wid: 2.1 }, { hgt: 1.6, wid: 3.2 }];
const panels = [0.7, 1, 1.6];

test('a card of any shape stays inside the share of the view that leaves room for the name and the hint', () => {
  for (const s of shapes) for (const aspect of panels) {
    const distance = fitDistance({ ...s, aspect, fovDeg: 32 });
    const c = coverage({ ...s, aspect, fovDeg: 32, distance });
    assert.ok(c.height <= FILL + 1e-9 && c.width <= FILL + 1e-9, `${s.wid}x${s.hgt} in a ${aspect} panel covers ${c.width.toFixed(2)} x ${c.height.toFixed(2)}`);
    assert.ok(Math.max(c.height, c.width) > FILL * 0.8, 'and it is not shrunk to a speck');
  }
});

test('zooming in brings the camera closer and never behind the card', () => {
  const base = fitDistance({ hgt: 1.6, wid: 1.6, aspect: 1, fovDeg: 32 });
  assert.ok(fitDistance({ hgt: 1.6, wid: 1.6, aspect: 1, fovDeg: 32, zoom: 2 }) < base);
  assert.ok(fitDistance({ hgt: 1.6, wid: 1.6, aspect: 1, fovDeg: 32, zoom: 2.4 }) > 0);
});
