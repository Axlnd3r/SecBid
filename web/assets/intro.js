/*
 * The landing intro: scroll position → --p (0..1) and data-beat (0..4). The clip is optional
 * (it is not in the repo); without it the poster, or plain black, carries the scene.
 */
const intro = document.querySelector('[data-intro]');

if (intro) {
  const video = intro.querySelector('video');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (video && !reduced) {
    video.addEventListener('playing', () => video.classList.add('is-playing'), { once: true });
    video.addEventListener('error', () => video.remove(), { once: true });
    video.play().catch(() => {});
  } else if (video) {
    video.remove();
  }

  // 0 = title, 1..3 = the three statements, 4 = enter
  const BEATS = [0.12, 0.34, 0.56, 0.78];
  let last = -1;
  function frame() {
    const box = intro.getBoundingClientRect();
    const run = Math.max(1, box.height - innerHeight);
    const p = Math.min(1, Math.max(0, -box.top / run));
    intro.style.setProperty('--p', p.toFixed(4));
    const beat = BEATS.filter((b) => p >= b).length;
    if (beat !== last) {
      intro.dataset.beat = String(beat);
      last = beat;
    }
  }
  if (!reduced) {
    addEventListener('scroll', () => requestAnimationFrame(frame), { passive: true });
    addEventListener('resize', frame);
    frame();
  }

  // "Enter" and "Skip" jump past the intro to the explainer
  for (const a of intro.querySelectorAll('[data-enter]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById('explain') ?? intro.nextElementSibling;
      target.scrollIntoView({ behavior: a.dataset.enter === 'skip' || reduced ? 'auto' : 'smooth' });
    });
  }
}
