// Runs before first paint: mark the page as scripted and give animated words their stagger index.
document.documentElement.classList.add('js');
addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-i]').forEach((el) => el.style.setProperty('--i', el.dataset.i));
});
