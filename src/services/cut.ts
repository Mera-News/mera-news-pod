/**
 * The longest prefix of `page` that `fits`, found by binary search (a fit that holds for a prefix holds
 * for every shorter one). Never below one item, so a single large item still goes out alone.
 */
export function cutToFit<T>(page: T[], fits: (prefix: T[]) => boolean): T[] {
  if (page.length <= 1 || fits(page)) return page;
  let lo = 1; // kept without asking
  let hi = page.length - 1; // the whole page failed
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(page.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  return page.slice(0, lo);
}
