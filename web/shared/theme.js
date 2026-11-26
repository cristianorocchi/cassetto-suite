/* The suite's theme, the same in the shell and in every module page.
 *
 *   system  follow the system's light or dark (no data-theme)
 *   light, dark, oled   data-theme on <html>; oled is dark on true black
 *
 * The choice is kept in localStorage (one origin for the shell and its pages), and a change made in
 * one page reaches the others through the storage event.
 */
(function () {
  'use strict';
  const KEY = 'cassetto:theme';
  const THEMES = ['system', 'light', 'dark', 'oled'];
  const read = () => { try { const t = localStorage.getItem(KEY); return THEMES.includes(t) ? t : 'system'; } catch (e) { return 'system'; } };
  function apply(t) {
    const root = document.documentElement;
    if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
  }
  function set(t) {
    if (!THEMES.includes(t)) return;
    try { localStorage.setItem(KEY, t); } catch (e) { /* storage off: this page only */ }
    apply(t);
  }
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(read()); });
  apply(read());
  window.CassettoTheme = { themes: THEMES, get: read, set, apply };
})();
