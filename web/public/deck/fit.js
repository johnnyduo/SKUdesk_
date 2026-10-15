// Scales the fixed-size slides down to fit narrow screens.
const fit = () => document.documentElement.style.setProperty('--fit', String(Math.min(1, (innerWidth - 16) / 1280)));
fit();
addEventListener('resize', fit);
