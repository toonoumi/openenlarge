//! Negative-vs-positive classification from the decoded working buffer.
//! Tonal-inversion signal (not base color), so it generalizes across C-41
//! (orange base), B&W (neutral base), and Phoenix (bluish base).

use crate::Image;

/// Classify the working buffer as positive (`true`) or negative (`false`),
/// with a 0..1 confidence. Base-color independent: scores tonal spread and
/// channel balance, two signals that separate a normal photo (positive) from a
/// tonally-inverted, cast-dominated negative. Defaults to negative below a
/// confidence margin, preserving the app's original always-invert behavior.
pub fn classify_positive(working: &Image) -> (bool, f32) {
    let n = working.pixels.len();
    if n == 0 {
        return (false, 0.0);
    }

    // Per-channel luma stats: mean and spread (std-dev proxy via mean abs dev).
    let mut sum = [0f32; 3];
    for &px in &working.pixels {
        for c in 0..3 {
            sum[c] += px[c];
        }
    }
    let mean = [sum[0] / n as f32, sum[1] / n as f32, sum[2] / n as f32];
    let luma_mean = (mean[0] + mean[1] + mean[2]) / 3.0;

    let mut spread = 0f32;
    for &px in &working.pixels {
        let l = (px[0] + px[1] + px[2]) / 3.0;
        spread += (l - luma_mean).abs();
    }
    spread /= n as f32; // mean absolute deviation of luma, 0..~0.5

    // Channel imbalance: how far the channel means are from neutral, normalized.
    let chan_max = mean[0].max(mean[1]).max(mean[2]);
    let chan_min = mean[0].min(mean[1]).min(mean[2]);
    let imbalance = (chan_max - chan_min) / chan_max.max(1e-4); // 0..1

    // Positive evidence: wide tonal spread AND low cast. Negative is the inverse.
    //   spread:    >= 0.20 reads as full-range positive; <= 0.06 as flat negative.
    //   imbalance: <= 0.10 reads neutral (positive); >= 0.35 reads cast (negative).
    let spread_pos = ((spread - 0.06) / (0.20 - 0.06)).clamp(0.0, 1.0);
    let cast_neg = ((imbalance - 0.10) / (0.35 - 0.10)).clamp(0.0, 1.0);
    let positive_score = (spread_pos + (1.0 - cast_neg)) / 2.0; // 0..1

    // Confidence = distance from the 0.5 fence, scaled to 0..1.
    let confidence = ((positive_score - 0.5).abs() * 2.0).clamp(0.0, 1.0);

    // Default-to-negative margin: only call it positive when clearly past the fence.
    const POSITIVE_MARGIN: f32 = 0.60;
    (positive_score >= POSITIVE_MARGIN, confidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Image;

    fn solid(w: usize, h: usize, px: [f32; 3]) -> Image {
        Image {
            width: w,
            height: h,
            pixels: vec![px; w * h],
            ir: None,
        }
    }

    /// A "positive": natural full-range gradient from near-black to near-white,
    /// balanced channels.
    fn synthetic_positive() -> Image {
        let mut pixels = Vec::new();
        for i in 0..256 {
            let v = i as f32 / 255.0;
            pixels.push([v, v, v]);
        }
        Image {
            width: 256,
            height: 1,
            pixels,
            ir: None,
        }
    }

    /// A "negative": compressed, high, strongly orange-cast (C-41-like).
    fn synthetic_negative() -> Image {
        let mut pixels = Vec::new();
        for i in 0..256 {
            let v = 0.55 + (i as f32 / 255.0) * 0.2; // compressed, lifted
            pixels.push([v, v * 0.7, v * 0.4]); // orange cast
        }
        Image {
            width: 256,
            height: 1,
            pixels,
            ir: None,
        }
    }

    #[test]
    fn positive_image_classifies_positive() {
        let (is_pos, conf) = classify_positive(&synthetic_positive());
        assert!(
            is_pos,
            "full-range balanced image should read positive (conf {conf})"
        );
        assert!((0.0..=1.0).contains(&conf));
    }

    #[test]
    fn negative_image_classifies_negative() {
        let (is_pos, conf) = classify_positive(&synthetic_negative());
        assert!(
            !is_pos,
            "compressed orange-cast image should read negative (conf {conf})"
        );
        assert!((0.0..=1.0).contains(&conf));
    }

    #[test]
    fn flat_gray_defaults_negative() {
        let (is_pos, _conf) = classify_positive(&solid(16, 16, [0.5, 0.5, 0.5]));
        assert!(!is_pos, "ambiguous frame must default to negative");
    }

    #[test]
    fn empty_image_defaults_negative() {
        let (is_pos, conf) = classify_positive(&Image {
            width: 0,
            height: 0,
            pixels: vec![],
            ir: None,
        });
        assert!(!is_pos);
        assert_eq!(conf, 0.0);
    }
}
