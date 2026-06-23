//! ROI sampling: map 4 chart corners to a patch grid and sample each patch
//! with a trimmed mean (rejecting dust/scratch/edge outliers).

use crate::Image;

pub struct GridSpec {
    pub cols: usize,
    pub rows: usize,
    /// Fraction of each cell sampled around its center, in (0, 1].
    pub inset: f32,
}

/// Bilinear map of normalized (u,v) in [0,1]^2 across corners [TL,TR,BR,BL] → pixel (x,y).
fn bilerp(corners: &[[f32; 2]; 4], u: f32, v: f32) -> [f32; 2] {
    let [tl, tr, br, bl] = corners;
    let top = [tl[0] * (1.0 - u) + tr[0] * u, tl[1] * (1.0 - u) + tr[1] * u];
    let bot = [bl[0] * (1.0 - u) + br[0] * u, bl[1] * (1.0 - u) + br[1] * u];
    [
        top[0] * (1.0 - v) + bot[0] * v,
        top[1] * (1.0 - v) + bot[1] * v,
    ]
}

#[inline]
fn at(img: &Image, x: f32, y: f32) -> Option<[f32; 3]> {
    if x < 0.0 || y < 0.0 {
        return None;
    }
    let (xi, yi) = (x as usize, y as usize);
    if xi >= img.width || yi >= img.height {
        return None;
    }
    Some(img.pixels[yi * img.width + xi])
}

/// Sample one cell: gather an N×N grid of samples in the inset window, trimmed-mean by luma.
fn sample_cell(
    img: &Image,
    corners: &[[f32; 2]; 4],
    spec: &GridSpec,
    col: usize,
    row: usize,
    trim: f32,
) -> [f32; 3] {
    debug_assert!(trim < 0.5, "trim must be in [0, 0.5); got {trim}");
    const N: usize = 11; // 11x11 sub-samples per patch
    let cu = (col as f32 + 0.5) / spec.cols as f32;
    let cv = (row as f32 + 0.5) / spec.rows as f32;
    let half_u = 0.5 * spec.inset / spec.cols as f32;
    let half_v = 0.5 * spec.inset / spec.rows as f32;
    let mut samples: Vec<[f32; 3]> = Vec::with_capacity(N * N);
    for j in 0..N {
        for i in 0..N {
            let u = cu + (i as f32 / (N as f32 - 1.0) - 0.5) * 2.0 * half_u;
            let v = cv + (j as f32 / (N as f32 - 1.0) - 0.5) * 2.0 * half_v;
            let p = bilerp(corners, u, v);
            if let Some(px) = at(img, p[0], p[1]) {
                samples.push(px);
            }
        }
    }
    if samples.is_empty() {
        return [0.0, 0.0, 0.0];
    }
    // Trim by luma, average the survivors per channel.
    let luma = |c: [f32; 3]| 0.2627 * c[0] + 0.6780 * c[1] + 0.0593 * c[2];
    samples.sort_by(|a, b| luma(*a).partial_cmp(&luma(*b)).unwrap());
    let k = ((samples.len() as f32) * trim).floor() as usize;
    let slice = &samples[k..samples.len().saturating_sub(k).max(k + 1)];
    let mut acc = [0.0f32; 3];
    for s in slice {
        for c in 0..3 {
            acc[c] += s[c];
        }
    }
    let n = slice.len().max(1) as f32;
    [acc[0] / n, acc[1] / n, acc[2] / n]
}

/// Sample all patches, row-major (row 0 left→right, then row 1, …).
pub fn sample_grid(
    img: &Image,
    corners: &[[f32; 2]; 4],
    spec: &GridSpec,
    trim: f32,
) -> Vec<[f32; 3]> {
    let mut out = Vec::with_capacity(spec.cols * spec.rows);
    for row in 0..spec.rows {
        for col in 0..spec.cols {
            out.push(sample_cell(img, corners, spec, col, row, trim));
        }
    }
    out
}

/// Draw a downscaled sRGB preview with the sampled windows outlined, for human
/// verification of corner alignment and patch orientation.
pub fn sampling_overlay(
    positive: &Image,
    corners: &[[f32; 2]; 4],
    spec: &GridSpec,
    max_dim: usize,
) -> image::RgbImage {
    let scale = (max_dim as f32 / positive.width.max(positive.height) as f32).min(1.0);
    let ow = ((positive.width as f32 * scale).round() as u32).max(1);
    let oh = ((positive.height as f32 * scale).round() as u32).max(1);
    let mut out = image::RgbImage::new(ow, oh);
    // Nearest-neighbour downscale + display-encode (engine output is already sRGB-ish).
    for y in 0..oh {
        for x in 0..ow {
            let sx = ((x as f32 / scale) as usize).min(positive.width - 1);
            let sy = ((y as f32 / scale) as usize).min(positive.height - 1);
            let p = positive.pixels[sy * positive.width + sx];
            out.put_pixel(
                x,
                y,
                image::Rgb([
                    (p[0].clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                    (p[1].clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                    (p[2].clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                ]),
            );
        }
    }
    let plot = |out: &mut image::RgbImage, px: f32, py: f32, col: image::Rgb<u8>| {
        let x = (px * scale).round();
        let y = (py * scale).round();
        if x >= 0.0 && y >= 0.0 && (x as u32) < ow && (y as u32) < oh {
            out.put_pixel(x as u32, y as u32, col);
        }
    };
    // Outline each cell's inset window; mark the first patch (0,0) red.
    for row in 0..spec.rows {
        for col in 0..spec.cols {
            let cu = (col as f32 + 0.5) / spec.cols as f32;
            let cv = (row as f32 + 0.5) / spec.rows as f32;
            let hu = 0.5 * spec.inset / spec.cols as f32;
            let hv = 0.5 * spec.inset / spec.rows as f32;
            let color = if row == 0 && col == 0 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 255, 0])
            };
            let steps = 60;
            for s in 0..steps {
                let f = s as f32 / steps as f32;
                // four edges of the window
                for (u, v) in [
                    (cu - hu + 2.0 * hu * f, cv - hv),
                    (cu - hu + 2.0 * hu * f, cv + hv),
                    (cu - hu, cv - hv + 2.0 * hv * f),
                    (cu + hu, cv - hv + 2.0 * hv * f),
                ] {
                    let p = bilerp(corners, u, v);
                    plot(&mut out, p[0], p[1], color);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Image;

    // Build a 2x2 grid image: each cell a flat color, with a few dust pixels.
    fn synth() -> Image {
        let (w, h) = (40usize, 40usize);
        let mut px = vec![[0.0f32; 3]; w * h];
        let colors = [
            [1.0, 0.0, 0.0], // TL  (col0,row0)
            [0.0, 1.0, 0.0], // TR  (col1,row0)
            [0.0, 0.0, 1.0], // BL  (col0,row1)
            [1.0, 1.0, 0.0], // BR  (col1,row1)
        ];
        for y in 0..h {
            for x in 0..w {
                let c = (x >= w / 2) as usize + 2 * (y >= h / 2) as usize;
                // map cell index (TL,TR,BL,BR) -> colors order above
                let color = match c {
                    0 => colors[0],
                    1 => colors[1],
                    2 => colors[2],
                    _ => colors[3],
                };
                px[y * w + x] = color;
            }
        }
        // Dust: a white and a black speck inside the TL cell center.
        px[10 * w + 10] = [1.0, 1.0, 1.0];
        px[11 * w + 11] = [0.0, 0.0, 0.0];
        Image {
            width: w,
            height: h,
            pixels: px,
            ir: None,
        }
    }

    #[test]
    fn samples_row_major_means() {
        let img = synth();
        let corners = [[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0]];
        let spec = GridSpec {
            cols: 2,
            rows: 2,
            inset: 0.5,
        };
        let got = sample_grid(&img, &corners, &spec, 0.2);
        assert_eq!(got.len(), 4);
        // Row-major: [TL, TR, BL, BR] = red, green, blue, yellow.
        let near = |a: [f32; 3], b: [f32; 3]| (0..3).all(|i| (a[i] - b[i]).abs() < 0.05);
        assert!(near(got[0], [1.0, 0.0, 0.0]), "TL={:?}", got[0]);
        assert!(near(got[1], [0.0, 1.0, 0.0]), "TR={:?}", got[1]);
        assert!(near(got[2], [0.0, 0.0, 1.0]), "BL={:?}", got[2]);
        assert!(near(got[3], [1.0, 1.0, 0.0]), "BR={:?}", got[3]);
    }

    #[test]
    fn overlay_downscales_and_is_rgb() {
        let img = synth();
        let corners = [[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0]];
        let spec = GridSpec {
            cols: 2,
            rows: 2,
            inset: 0.5,
        };
        let ov = sampling_overlay(&img, &corners, &spec, 20);
        assert!(ov.width().max(ov.height()) <= 20);
        assert!(ov.width() > 0 && ov.height() > 0);
    }
}
