/**
 * Playlist queue logic, kept pure so it can be unit tested without a browser.
 *
 * Sequential mode is the "LOOP ALL" behaviour: it starts at the first track,
 * walks the list in order and, after the last track, wraps back to the first.
 * Shuffle mode picks a random track but never repeats the one that just played
 * while another option exists. Tracks that failed to load are skipped.
 */
export function nextTrack({ tracks = [], currentFile = null, shuffle = false, failed = [], random = Math.random } = {}) {
  const broken = new Set(failed);
  const pool = tracks.filter((track) => track && track.file && !broken.has(track.file));
  if (!pool.length) return null;

  if (shuffle) {
    const candidates = pool.filter((track) => track.file !== currentFile);
    const list = candidates.length ? candidates : pool;
    const index = Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)));
    return list[index];
  }

  const currentIndex = tracks.findIndex((track) => track && track.file === currentFile);
  for (let step = 1; step <= tracks.length; step += 1) {
    const index = (currentIndex + step + tracks.length) % tracks.length;
    const candidate = tracks[index];
    if (candidate && candidate.file && !broken.has(candidate.file)) return candidate;
  }
  return pool[0];
}
