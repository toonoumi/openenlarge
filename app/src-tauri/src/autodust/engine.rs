//! AI dust/hair inference: detector U-Net → probability map, MI-GAN inpaint over
//! masked tiles. Reuses the upscaler's `plan_tiles`/`Tile` tiling.

use crate::upscale::engine::{plan_tiles, Tile};
use film_core::dust::Mask;

/// Indices of `tiles` whose inner rect overlaps any masked pixel. Used to skip
/// clean tiles so MI-GAN only runs where there is something to fill.
pub fn masked_tiles(tiles: &[Tile], mask: &Mask) -> Vec<usize> {
    let mut out = Vec::new();
    if mask.w == 0 || mask.h == 0 {
        return out;
    }
    for (i, t) in tiles.iter().enumerate() {
        let mut hit = false;
        'scan: for yy in t.oy..(t.oy + t.ih) {
            for xx in t.ox..(t.ox + t.iw) {
                // mask spans the whole frame (x0=y0=0); index directly.
                if xx < mask.w && yy < mask.h && mask.bits[yy * mask.w + xx] {
                    hit = true;
                    break 'scan;
                }
            }
        }
        if hit {
            out.push(i);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masked_tiles_selects_only_tiles_overlapping_the_mask() {
        // 500x300 frame, 128px tiles. Put one masked pixel at (10,10) → only the
        // top-left tile should be selected.
        let (w, h) = (500usize, 300usize);
        let tiles = plan_tiles(w, h, 128, 8);
        let mut bits = vec![false; w * h];
        bits[10 * w + 10] = true;
        let mask = Mask { x0: 0, y0: 0, w, h, bits };
        let sel = masked_tiles(&tiles, &mask);
        assert_eq!(sel.len(), 1);
        let t = tiles[sel[0]];
        assert!(t.ox <= 10 && 10 < t.ox + t.iw && t.oy <= 10 && 10 < t.oy + t.ih);
    }

    #[test]
    fn masked_tiles_empty_for_empty_mask() {
        let tiles = plan_tiles(200, 200, 128, 8);
        let mask = Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
        assert!(masked_tiles(&tiles, &mask).is_empty());
    }
}
