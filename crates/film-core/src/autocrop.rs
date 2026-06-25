//! Detect a bright lightbox / scanner border around a film scan and return the
//! framed content rectangle. Runs on the import-time thumbnail. Conservative by
//! design: only fires on an unmistakable 4-sided flat-white border, otherwise
//! returns `None` (leave the image full-frame).

use crate::image::Image;

// A pixel counts as "white" when all three linear channels are near max.
const WHITE_THRESH: f32 = 0.90;
// A border row/column is a "white margin" when this fraction of its pixels are white.
const WHITE_FRAC: f32 = 0.95;
// Per-side trim must stay under this fraction of the dimension (rejects runaway crops).
const MAX_TRIM: f32 = 0.25;
// The trimmed border must be flat: high mean brightness, low variance.
const MARGIN_MEAN_MIN: f32 = 0.92;
const MARGIN_STD_MAX: f32 = 0.02;

fn is_white(p: [f32; 3]) -> bool {
    p[0] >= WHITE_THRESH && p[1] >= WHITE_THRESH && p[2] >= WHITE_THRESH
}

/// Detect a bright lightbox/scanner border. Returns the content rect as
/// `[x, y, w, h]` normalized 0..1, or `None` if there is no confident 4-sided
/// flat-white border. See module docs for the conservative guard rules.
pub fn detect_lightbox_crop(img: &Image) -> Option<[f32; 4]> {
    let (w, h) = (img.width, img.height);
    if w < 8 || h < 8 {
        return None;
    }
    let px = |x: usize, y: usize| img.pixels[y * w + x];

    let row_is_margin = |y: usize| -> bool {
        let white = (0..w).filter(|&x| is_white(px(x, y))).count();
        white as f32 / w as f32 >= WHITE_FRAC
    };
    let col_is_margin = |x: usize| -> bool {
        let white = (0..h).filter(|&y| is_white(px(x, y))).count();
        white as f32 / h as f32 >= WHITE_FRAC
    };

    // Scan inward from each edge to the first non-margin line.
    let top = (0..h).find(|&y| !row_is_margin(y)).unwrap_or(h);
    let bottom = (0..h).rev().find(|&y| !row_is_margin(y)).unwrap_or(0);
    let left = (0..w).find(|&x| !col_is_margin(x)).unwrap_or(w);
    let right = (0..w).rev().find(|&x| !col_is_margin(x)).unwrap_or(0);

    // Closing frame: every side must have at least one white-margin line, and the
    // content box must be non-degenerate.
    if top == 0 || left == 0 || bottom + 1 >= h || right + 1 >= w {
        return None;
    }
    if right <= left || bottom <= top {
        return None;
    }

    // Modest trim: each side keeps the crop reasonable.
    let trim_top = top as f32 / h as f32;
    let trim_bottom = (h - 1 - bottom) as f32 / h as f32;
    let trim_left = left as f32 / w as f32;
    let trim_right = (w - 1 - right) as f32 / w as f32;
    if trim_top >= MAX_TRIM
        || trim_bottom >= MAX_TRIM
        || trim_left >= MAX_TRIM
        || trim_right >= MAX_TRIM
    {
        return None;
    }

    // Flatness: the trimmed border must be uniformly bright (rejects skies/walls).
    // Accumulate luma over the four margin bands (outside the content box).
    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut n = 0u64;
    for y in 0..h {
        for x in 0..w {
            let in_content = x >= left && x <= right && y >= top && y <= bottom;
            if in_content {
                continue;
            }
            let p = px(x, y);
            let luma = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) as f64;
            sum += luma;
            sum_sq += luma * luma;
            n += 1;
        }
    }
    if n == 0 {
        return None;
    }
    let mean = sum / n as f64;
    let var = (sum_sq / n as f64 - mean * mean).max(0.0);
    let std = var.sqrt();
    if mean < MARGIN_MEAN_MIN as f64 || std > MARGIN_STD_MAX as f64 {
        return None;
    }

    let x = left as f32 / w as f32;
    let y = top as f32 / h as f32;
    let rw = (right - left + 1) as f32 / w as f32;
    let rh = (bottom - top + 1) as f32 / h as f32;
    Some([x, y, rw, rh])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::Image;

    /// Build a `w`×`h` image filled with `bg`, then paint an inner rectangle
    /// [x0,x1)×[y0,y1) with `fg`.
    fn boxed(
        w: usize,
        h: usize,
        bg: [f32; 3],
        fg: [f32; 3],
        x0: usize,
        y0: usize,
        x1: usize,
        y1: usize,
    ) -> Image {
        let mut img = Image::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let inside = x >= x0 && x < x1 && y >= y0 && y < y1;
                img.pixels[y * w + x] = if inside { fg } else { bg };
            }
        }
        img
    }

    const WHITE: [f32; 3] = [1.0, 1.0, 1.0];
    const GRAY: [f32; 3] = [0.3, 0.25, 0.2];

    #[test]
    fn detects_white_border_around_content() {
        // 100×100, white border 10px on every side, gray center [10,90)×[10,90).
        let img = boxed(100, 100, WHITE, GRAY, 10, 10, 90, 90);
        let r = detect_lightbox_crop(&img).expect("should detect border");
        let [x, y, w, h] = r;
        assert!((x - 0.10).abs() < 0.02, "x={x}");
        assert!((y - 0.10).abs() < 0.02, "y={y}");
        assert!((w - 0.80).abs() < 0.02, "w={w}");
        assert!((h - 0.80).abs() < 0.02, "h={h}");
    }

    #[test]
    fn no_border_returns_none() {
        // Solid gray, no white margin anywhere.
        let img = boxed(100, 100, GRAY, GRAY, 0, 0, 100, 100);
        assert_eq!(detect_lightbox_crop(&img), None);
    }

    #[test]
    fn one_bright_edge_is_not_a_frame() {
        // White only along the top 10 rows; other three sides are gray.
        // Not a closing frame → None.
        let img = boxed(100, 100, GRAY, WHITE, 0, 0, 100, 10);
        assert_eq!(detect_lightbox_crop(&img), None);
    }

    #[test]
    fn gradient_border_is_rejected_by_variance() {
        // Build a frame whose border is a vertical brightness gradient (like a
        // sky), bright enough to pass the white threshold at the very edge but
        // high-variance across the margin → rejected.
        let (w, h) = (100usize, 100usize);
        let mut img = Image::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let inside = x >= 10 && x < 90 && y >= 10 && y < 90;
                let v = if inside { 0.3 } else { 0.90 + 0.10 * (x as f32 / w as f32) };
                img.pixels[y * w + x] = [v, v, v];
            }
        }
        assert_eq!(detect_lightbox_crop(&img), None);
    }

    #[test]
    fn runaway_crop_is_rejected() {
        // White border 40px each side on a 100px image → would trim 40% per
        // side (> 25% cap) → None.
        let img = boxed(100, 100, WHITE, GRAY, 40, 40, 60, 60);
        assert_eq!(detect_lightbox_crop(&img), None);
    }

    #[test]
    fn ignores_tiny_or_degenerate_images() {
        let img = Image::new(1, 1);
        assert_eq!(detect_lightbox_crop(&img), None);
    }
}
