//! Pure canvas model: world/screen transform, hit testing, drag gestures.
//! No GPUI types, so it unit-tests without a window.

use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct P {
    pub x: f32,
    pub y: f32,
}

pub const fn p(x: f32, y: f32) -> P {
    P { x, y }
}

#[derive(Clone, Debug)]
pub struct Card {
    pub pos: P,
    pub w: f32,
    pub h: f32,
    pub image: String,
}

impl Card {
    fn contains(&self, w: P) -> bool {
        w.x >= self.pos.x && w.x <= self.pos.x + self.w && w.y >= self.pos.y && w.y <= self.pos.y + self.h
    }
    fn intersects(&self, a: P, b: P) -> bool {
        let (x0, x1) = (a.x.min(b.x), a.x.max(b.x));
        let (y0, y1) = (a.y.min(b.y), a.y.max(b.y));
        self.pos.x < x1 && self.pos.x + self.w > x0 && self.pos.y < y1 && self.pos.y + self.h > y0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tool {
    Select,
    Hand,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Gesture {
    Idle,
    Move { last: P },
    Pan { last: P },
    Marquee { start: P, cur: P },
}

pub struct Canvas {
    pub cards: Vec<Card>,
    pub pan: P,
    pub zoom: f32,
    pub selected: BTreeSet<usize>,
    pub gesture: Gesture,
    pub tool: Tool,
}

pub const MIN_ZOOM: f32 = 0.05;
pub const MAX_ZOOM: f32 = 8.0;

impl Canvas {
    pub fn new(cards: Vec<Card>) -> Self {
        Self { cards, pan: p(0., 0.), zoom: 1.0, selected: BTreeSet::new(), gesture: Gesture::Idle, tool: Tool::Select }
    }

    /// Masonry-pack `(image, aspect)` into `cols` columns of width `col_w`.
    pub fn masonry(items: &[(String, f32)], cols: usize, col_w: f32, gap: f32, origin: P) -> Vec<Card> {
        let mut heights = vec![0f32; cols];
        items
            .iter()
            .map(|(image, aspect)| {
                let c = (0..cols).min_by(|a, b| heights[*a].total_cmp(&heights[*b])).unwrap();
                let h = col_w / aspect;
                let card = Card { pos: p(origin.x + c as f32 * (col_w + gap), origin.y + heights[c]), w: col_w, h, image: image.clone() };
                heights[c] += h + gap;
                card
            })
            .collect()
    }

    pub fn to_world(&self, s: P) -> P {
        p((s.x - self.pan.x) / self.zoom, (s.y - self.pan.y) / self.zoom)
    }

    pub fn to_screen(&self, w: P) -> P {
        p(w.x * self.zoom + self.pan.x, w.y * self.zoom + self.pan.y)
    }

    /// Topmost card under a screen point (last painted wins).
    pub fn hit(&self, s: P) -> Option<usize> {
        let w = self.to_world(s);
        self.cards.iter().rposition(|c| c.contains(w))
    }

    /// Zoom by `factor` keeping the world point under `anchor` fixed.
    pub fn zoom_at(&mut self, anchor: P, factor: f32) {
        let before = self.to_world(anchor);
        self.zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        self.pan = p(anchor.x - before.x * self.zoom, anchor.y - before.y * self.zoom);
    }

    pub fn scroll(&mut self, dx: f32, dy: f32) {
        self.pan = p(self.pan.x + dx, self.pan.y + dy);
    }

    pub fn press(&mut self, s: P, shift: bool) {
        if self.tool == Tool::Hand {
            self.gesture = Gesture::Pan { last: s };
            return;
        }
        match self.hit(s) {
            Some(i) => {
                if shift {
                    if !self.selected.remove(&i) {
                        self.selected.insert(i);
                    }
                } else if !self.selected.contains(&i) {
                    self.selected = [i].into();
                }
                // Bring the pressed card to the front; remap selection indices.
                let card = self.cards.remove(i);
                self.cards.push(card);
                let last = self.cards.len() - 1;
                self.selected = self.selected.iter().map(|&j| if j == i { last } else if j > i { j - 1 } else { j }).collect();
                self.gesture = if self.selected.contains(&last) { Gesture::Move { last: s } } else { Gesture::Idle };
            }
            None => {
                if !shift {
                    self.selected.clear();
                }
                let w = self.to_world(s);
                self.gesture = Gesture::Marquee { start: w, cur: w };
            }
        }
    }

    pub fn drag(&mut self, s: P) {
        match self.gesture {
            Gesture::Move { last } => {
                let (dx, dy) = ((s.x - last.x) / self.zoom, (s.y - last.y) / self.zoom);
                for &i in &self.selected {
                    let c = &mut self.cards[i];
                    c.pos = p(c.pos.x + dx, c.pos.y + dy);
                }
                self.gesture = Gesture::Move { last: s };
            }
            Gesture::Pan { last } => {
                self.scroll(s.x - last.x, s.y - last.y);
                self.gesture = Gesture::Pan { last: s };
            }
            Gesture::Marquee { start, .. } => {
                let cur = self.to_world(s);
                self.gesture = Gesture::Marquee { start, cur };
            }
            Gesture::Idle => {}
        }
    }

    pub fn release(&mut self) {
        if let Gesture::Marquee { start, cur } = self.gesture {
            for (i, c) in self.cards.iter().enumerate() {
                if c.intersects(start, cur) {
                    self.selected.insert(i);
                }
            }
        }
        self.gesture = Gesture::Idle;
    }

    /// Fit all cards into a viewport of `vw`x`vh` with `margin` px.
    pub fn fit(&mut self, vw: f32, vh: f32, margin: f32) {
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for c in &self.cards {
            x0 = x0.min(c.pos.x);
            y0 = y0.min(c.pos.y);
            x1 = x1.max(c.pos.x + c.w);
            y1 = y1.max(c.pos.y + c.h);
        }
        if x0 > x1 {
            return;
        }
        self.zoom = ((vw - 2. * margin) / (x1 - x0)).min((vh - 2. * margin) / (y1 - y0)).clamp(MIN_ZOOM, MAX_ZOOM);
        self.pan = p((vw - (x1 - x0) * self.zoom) / 2. - x0 * self.zoom, (vh - (y1 - y0) * self.zoom) / 2. - y0 * self.zoom);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board() -> Canvas {
        let items: Vec<_> = (0..6).map(|i| (format!("c{i}"), if i % 2 == 0 { 1.0 } else { 0.5 })).collect();
        Canvas::new(Canvas::masonry(&items, 3, 100., 10., p(0., 0.)))
    }

    #[test]
    fn masonry_fills_shortest_column() {
        let c = board().cards;
        assert_eq!((c[0].pos, c[1].pos, c[2].pos), (p(0., 0.), p(110., 0.), p(220., 0.)));
        // col0 h=100, col1 h=200, col2 h=100 -> item 3 goes to col0, item 4 to col2.
        assert_eq!(c[3].pos, p(0., 110.));
        assert_eq!(c[4].pos, p(220., 110.));
    }

    #[test]
    fn zoom_keeps_anchor_fixed_and_clamps() {
        let mut b = board();
        b.scroll(37., -12.);
        let anchor = p(150., 80.);
        let w = b.to_world(anchor);
        b.zoom_at(anchor, 2.5);
        let s = b.to_screen(w);
        assert!((s.x - anchor.x).abs() < 1e-3 && (s.y - anchor.y).abs() < 1e-3);
        b.zoom_at(anchor, 1000.);
        assert_eq!(b.zoom, MAX_ZOOM);
    }

    #[test]
    fn click_selects_and_drag_moves_in_world_units() {
        let mut b = board();
        b.zoom_at(p(0., 0.), 2.0);
        b.press(p(20., 20.), false); // card 0 at zoom 2
        let top = b.cards.len() - 1;
        assert_eq!(b.cards[top].image, "c0");
        assert_eq!(b.selected, [top].into());
        b.drag(p(60., 20.));
        b.release();
        assert_eq!(b.cards[top].pos, p(20., 0.)); // 40 screen px / zoom 2
    }

    #[test]
    fn shift_toggles_and_marquee_adds() {
        let mut b = board();
        b.press(p(5., 5.), false);
        b.release();
        b.press(p(115., 5.), true);
        b.release();
        assert_eq!(b.selected.len(), 2);
        b.press(p(500., 500.), false); // empty space clears, starts marquee
        b.drag(p(-5., -5.));
        b.release();
        assert_eq!(b.selected.len(), 6);
    }

    #[test]
    fn hand_tool_pans() {
        let mut b = board();
        b.tool = Tool::Hand;
        b.press(p(10., 10.), false);
        b.drag(p(30., 50.));
        b.release();
        assert_eq!(b.pan, p(20., 40.));
        assert!(b.selected.is_empty());
    }

    #[test]
    fn fit_contains_everything() {
        let mut b = board();
        b.fit(800., 600., 40.);
        for c in &b.cards {
            let a = b.to_screen(c.pos);
            let z = b.to_screen(p(c.pos.x + c.w, c.pos.y + c.h));
            assert!(a.x >= 39. && a.y >= 39. && z.x <= 761. && z.y <= 561., "{a:?} {z:?}");
        }
    }
}
