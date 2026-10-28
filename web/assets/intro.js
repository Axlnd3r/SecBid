/*
 * The landing intro: scroll position → --p (0..1), data-beat (0..4) and the clip's playhead, so the
 * film moves only while the reader scrolls, forwards or backwards. The clip is optional
 * (it is not in the repo); without it the poster, or plain black, carries the scene.
 */
const intro = document.querySelector('[data-intro]');

if (intro) {
  const video = intro.querySelector('video');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // the playhead chases the scroll position and eases toward it; it never plays on its own
  const scrub = { target: 0, at: 0, ready: false };
  if (video && !reduced) {
    video.addEventListener('error', () => video.remove(), { once: true });
    video.addEventListener('loadeddata', () => {
      scrub.ready = true;
      video.classList.add('is-playing');
      seek();
    }, { once: true });
    video.load();
  } else if (video) {
    video.remove();
  }
  function seek() {
    if (!scrub.ready || !video.isConnected) return;
    const gap = scrub.target - scrub.at;
    scrub.at = Math.abs(gap) < 0.004 ? scrub.target : scrub.at + gap * 0.18;
    if (!video.seeking && Math.abs(video.currentTime - scrub.at) > 0.008) video.currentTime = scrub.at;
    if (scrub.at !== scrub.target) requestAnimationFrame(seek);
  }

  // 0 = title, 1..3 = the three statements, 4 = enter
  const BEATS = [0.12, 0.34, 0.56, 0.78];
  let last = -1;
  function frame() {
    const box = intro.getBoundingClientRect();
    const run = Math.max(1, box.height - innerHeight);
    const p = Math.min(1, Math.max(0, -box.top / run));
    intro.style.setProperty('--p', p.toFixed(4));
    if (scrub.ready && video.duration) {
      const settled = scrub.at === scrub.target;
      scrub.target = p * (video.duration - 0.05);
      if (settled) requestAnimationFrame(seek);
    }
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
