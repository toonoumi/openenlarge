export interface Bins { r: number[]; g: number[]; b: number[] }

/** Bin RGBA bytes (from canvas getImageData) into 256 buckets per channel. */
export function binPixels(data: Uint8ClampedArray): Bins {
  const r = new Array(256).fill(0);
  const g = new Array(256).fill(0);
  const b = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++;
  }
  return { r, g, b };
}

/** Light Gaussian blur over the bins so single-bucket spikes read as a smooth
 *  wave instead of a comb. `radius` is in bins (0 disables); edges are clamped
 *  (replicated) so the curve doesn't dip at 0/255. */
export function smoothBins(bins: number[], radius = 3): number[] {
  if (radius <= 0) return bins;
  const n = bins.length;
  const sigma = radius / 2 + 0.5;
  const w: number[] = [];
  let wsum = 0;
  for (let k = -radius; k <= radius; k++) {
    const g = Math.exp(-(k * k) / (2 * sigma * sigma));
    w.push(g); wsum += g;
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      acc += bins[j < 0 ? 0 : j >= n ? n - 1 : j] * w[k + radius];
    }
    out[i] = acc / wsum;
  }
  return out;
}

/** Build an SVG polyline points string for one channel, normalized to height h.
 *  Bins are smoothed first (set `smooth` to 0 for the raw comb). A wider radius
 *  tames the quantization spikes ("comb teeth") into a smooth wave. */
export function channelPath(bins: number[], w: number, h: number, smooth = 7): string {
  const sb = smoothBins(bins, smooth);
  const max = Math.max(1, ...sb);
  return sb.map((v, i) => {
    const x = (i / 255) * w;
    const y = h - (v / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}
