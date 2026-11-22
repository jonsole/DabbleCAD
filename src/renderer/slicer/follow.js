// Following the nozzle between the printer's position reports. The printer says where the nozzle is
// a couple of times a second; in between, the nozzle is moved along the sliced tool path at the
// G-code's feed rates, starting from the point on the path that matches the last report.
const SEARCH_BACK = 60, SEARCH_AHEAD = 6000;
// Better behind than ahead: the printer rarely reaches the programmed feed rate (acceleration), and the
// guess never runs more than a little past the next expected report.
const SPEED = 0.7;

export class NozzleFollower {
  /** @param parsed parseGcode() result (needs path / pathAt) */
  constructor(parsed) {
    this.p = parsed.path; this.at = parsed.pathAt; this.n = this.at.length;
    this.k = -1; this.u = 0; this.t = 0; this.lost = true;
    this.tau = null; this.lastNow = 0;   // where the shown nozzle is, as time along the path
  }

  /** The first move at or after a byte offset in the file. */
  indexAtByte(b) {
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.at[mid] < b) lo = mid + 1; else hi = mid; }
    return lo;
  }

  _best(pos, from, to) {
    const p = this.p;
    let best = Infinity, bk = -1, bu = 0;
    for (let k = Math.max(1, from); k < Math.min(this.n, to); k++) {
      const ax = p[(k - 1) * 4], ay = p[(k - 1) * 4 + 1], az = p[(k - 1) * 4 + 2];
      const bx = p[k * 4], by = p[k * 4 + 1], bz = p[k * 4 + 2];
      const dx = bx - ax, dy = by - ay, dz = bz - az, l2 = dx * dx + dy * dy + dz * dz;
      let u = l2 > 1e-9 ? ((pos.x - ax) * dx + (pos.y - ay) * dy + (pos.z - az) * dz) / l2 : 1;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = ax + dx * u - pos.x, ey = ay + dy * u - pos.y, ez = az + dz * u - pos.z;
      const d = Math.hypot(ex, ey) + 10 * Math.abs(ez);          // the right layer matters most
      if (d < best - 1e-6) { best = d; bk = k; bu = u; }
    }
    return { d: best, k: bk, u: bu };
  }

  /** A position report ({x,y,z}) taken at `now` (ms); `fileByte` (optional) is how far the printer has read the file. */
  anchor(pos, now, fileByte) {
    let r = null;
    if (!this.lost && this.k > 0) r = this._best(pos, this.k - SEARCH_BACK, this.k + SEARCH_AHEAD);
    if ((!r || r.d > 3) && fileByte != null) { const h = this.indexAtByte(fileByte); r = this._best(pos, h - 3000, h + 300); }
    if (!r || r.d > 3) r = this._best(pos, 1, this.n);                   // look everywhere
    this.lost = !(r.k > 0 && r.d <= 3);
    if (!this.lost) {
      this.k = r.k; this.u = r.u; this.t = now;
    }
    return !this.lost;
  }

  /** Time (s, at SPEED x feed rate) to reach the end of each move from the start of the file. */
  _times() {
    if (this.T) return this.T;
    const p = this.p, T = new Float64Array(this.n);
    for (let k = 1; k < this.n; k++) {
      const i0 = (k - 1) * 4, i1 = k * 4;
      const L = Math.hypot(p[i1] - p[i0], p[i1 + 1] - p[i0 + 1], p[i1 + 2] - p[i0 + 2]);
      T[k] = T[k - 1] + L / Math.max(1, (p[i1 + 3] / 60) * SPEED);
    }
    return (this.T = T);
  }
  _timeAt(k, u) { const T = this._times(); return T[k - 1] + (T[k] - T[k - 1]) * u; }
  _at(tau) {
    const T = this._times();
    let lo = 1, hi = this.n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid] < tau) lo = mid + 1; else hi = mid; }
    const d = T[lo] - T[lo - 1];
    return { k: lo, u: d > 1e-9 ? Math.min(1, Math.max(0, (tau - T[lo - 1]) / d)) : 1 };
  }

  /**
   * Where to draw the nozzle now. The target runs on from the last report along the path; the shown
   * nozzle chases it smoothly, a little faster when behind and slower (never stopping, never going
   * back) when ahead, so reports nudge it instead of making it jump or halt.
   */
  estimate(now) {
    if (this.lost) return null;
    const target = this._timeAt(this.k, this.u) + Math.min(2, Math.max(0, (now - this.t) / 1000));
    const dt = this.lastNow ? Math.min(0.25, Math.max(0, (now - this.lastNow) / 1000)) : 0;
    this.lastNow = now;
    if (this.tau == null || Math.abs(target - this.tau) > 5) this.tau = target;           // first time, or a real jump
    else {
      const rate = Math.min(2.5, Math.max(0.3, 1 + (target - this.tau) / 0.8));
      this.tau += dt * rate;
    }
    const { k, u } = this._at(this.tau);
    const p = this.p, i0 = (k - 1) * 4, i1 = k * 4;
    return { k, x: p[i0] + (p[i1] - p[i0]) * u, y: p[i0 + 1] + (p[i1 + 1] - p[i0 + 1]) * u, z: p[i0 + 2] + (p[i1 + 2] - p[i0 + 2]) * u };
  }
}
