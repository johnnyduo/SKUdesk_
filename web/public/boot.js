// Runs before first paint: marks the page as scripted and gives animated words their stagger index.
document.documentElement.classList.add('js');
addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-i]').forEach((el) => el.style.setProperty('--i', el.dataset.i));
});
