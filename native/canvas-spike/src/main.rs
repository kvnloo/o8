//! canvas-spike: a native infinite moodboard canvas (pan, zoom-at-cursor,
//! select, shift/marquee multi-select, drag) with frosted floating chrome,
//! on o8-next's vendored GPUI 0.2.2.
//!
//! `CANVAS_SPIKE_SCRIPT=1` drives the same model methods on timers, runs a
//! 2 s animated pan to measure delivered frames, prints receipts and quits.

mod model;

use gpui::{
    App, Application, Bounds, Context, Hsla, MouseButton, MouseDownEvent, MouseMoveEvent, ObjectFit, ScrollWheelEvent,
    SharedString, TitlebarOptions, Window, WindowBackgroundAppearance, WindowBounds, WindowOptions, div, img,
    linear_color_stop, linear_gradient, point, prelude::*, px, rgb, rgba, size,
};
use model::{Canvas, Gesture, P, Tool, p};
use std::{path::PathBuf, time::{Duration, Instant}};

const W: f32 = 1400.;
const H: f32 = 900.;

struct Board {
    canvas: Canvas,
    tab: usize,
    anim: Option<(Instant, Vec<Instant>)>,
}

fn png_aspect(path: &std::path::Path) -> f32 {
    let b = std::fs::read(path).unwrap_or_default();
    if b.len() < 24 {
        return 1.0;
    }
    let w = u32::from_be_bytes(b[16..20].try_into().unwrap()) as f32;
    let h = u32::from_be_bytes(b[20..24].try_into().unwrap()) as f32;
    w / h
}

impl Board {
    fn new() -> Self {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets");
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        files.sort();
        // Two loose clusters, like a moodboard.
        let items: Vec<_> = files.iter().map(|f| (f.to_string_lossy().into_owned(), png_aspect(f))).collect();
        let (a, b) = items.split_at(items.len() / 2);
        let mut cards = Canvas::masonry(a, 3, 220., 14., p(0., 0.));
        cards.extend(Canvas::masonry(b, 2, 260., 14., p(820., 120.)));
        let mut canvas = Canvas::new(cards);
        canvas.fit(W, H, 120.);
        Self { canvas, tab: 0, anim: None }
    }

    fn glass() -> gpui::Div {
        div()
            .bg(linear_gradient(
                180.,
                linear_color_stop(rgba(0xffffff22), 0.),
                linear_color_stop(rgba(0x1a1a1ecc), 1.),
            ))
            .border_1()
            .border_color(rgba(0xffffff33))
            .shadow_lg()
            .rounded_full()
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let tools: [(&str, Option<Tool>); 9] = [
            ("↖", Some(Tool::Select)),
            ("✋", Some(Tool::Hand)),
            ("✎", None),
            ("◯", None),
            ("▢", None),
            ("→", None),
            ("T", None),
            ("▤", None),
            ("+", None),
        ];
        Self::glass().flex().gap_1().p_1().children(tools.into_iter().enumerate().map(|(i, (label, tool))| {
            let active = tool == Some(self.canvas.tool);
            div()
                .id(("tool", i))
                .size(px(36.))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .text_color(if tool.is_some() { gpui::white() } else { Hsla::from(rgba(0xffffff66)) })
                .when(active, |d| d.bg(rgba(0xffffff33)))
                .hover(|d| d.bg(rgba(0xffffff1a)))
                .child(label)
                .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    if let Some(t) = tool {
                        this.canvas.tool = t;
                        cx.notify();
                    }
                }))
        }))
    }

    fn run_script(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let wait = |ms| cx.background_executor().timer(Duration::from_millis(ms));
            wait(1500).await;
            println!("SHOT overview");
            wait(1200).await;
            this.update(cx, |b, cx| {
                let c = &mut b.canvas;
                // Marquee a few cards of the right cluster, then shift-click one on the left.
                let r = c.to_screen(p(820., 120.));
                c.press(p(r.x - 10., r.y - 10.), false);
                c.drag(p(r.x + 300., r.y + 260.));
                c.release();
                let l = c.to_screen(p(40., 40.));
                c.press(l, true);
                c.release();
                // Drag the selection 60 px down-right.
                let s = c.to_screen(p(840., 140.));
                c.press(s, false);
                c.drag(p(s.x + 60., s.y + 60.));
                c.release();
                c.zoom_at(p(W / 2., H / 2.), 1.6);
                println!("SELECTED {} cards, zoom {:.0}%", c.selected.len(), c.zoom * 100.);
                cx.notify();
            })
            .ok();
            wait(1500).await;
            println!("SHOT selected");
            wait(600).await;
            this.update(cx, |b, cx| {
                b.anim = Some((Instant::now(), Vec::new()));
                cx.notify();
            })
            .ok();
            wait(2600).await;
            this.update(cx, |_, cx| cx.quit()).ok();
        })
        .detach();
    }
}

impl Render for Board {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t0 = Instant::now();
        if let Some((start, frames)) = &mut self.anim {
            frames.push(Instant::now());
            let t = start.elapsed().as_secs_f32();
            if t < 2.0 {
                self.canvas.scroll(-3., 0.);
                window.request_animation_frame();
            } else {
                let gaps: Vec<f32> = frames.windows(2).map(|w| (w[1] - w[0]).as_secs_f32() * 1000.).collect();
                let mut sorted = gaps.clone();
                sorted.sort_by(f32::total_cmp);
                let p95 = sorted.get(sorted.len() * 95 / 100).copied().unwrap_or(0.);
                println!(
                    "ANIM frames={} fps={:.1} p95_gap_ms={:.2} max_gap_ms={:.2}",
                    frames.len(),
                    frames.len() as f32 / t,
                    p95,
                    sorted.last().copied().unwrap_or(0.)
                );
                self.anim = None;
            }
        }
        let c = &self.canvas;
        let z = c.zoom;
        let cards = c.cards.iter().enumerate().map(|(i, card)| {
            let s = c.to_screen(card.pos);
            let sel = c.selected.contains(&i);
            div()
                .absolute()
                .left(px(s.x))
                .top(px(s.y))
                .w(px(card.w * z))
                .h(px(card.h * z))
                .rounded(px(6. * z.min(1.)))
                .overflow_hidden()
                .shadow_md()
                .child(img(PathBuf::from(&card.image)).size_full().object_fit(ObjectFit::Cover))
                .when(sel, |d| d.border_2().border_color(rgb(0x3b82f6)))
        });
        let marquee = match c.gesture {
            Gesture::Marquee { start, cur } => {
                let (a, b) = (c.to_screen(start), c.to_screen(cur));
                Some(
                    div()
                        .absolute()
                        .left(px(a.x.min(b.x)))
                        .top(px(a.y.min(b.y)))
                        .w(px((a.x - b.x).abs()))
                        .h(px((a.y - b.y).abs()))
                        .bg(rgba(0x3b82f622))
                        .border_1()
                        .border_color(rgb(0x3b82f6)),
                )
            }
            _ => None,
        };
        let tabs = ["Balmy Storm", "Electric Sky", "Tidal Panda"];
        let zoom_label: SharedString = format!("{:.0}%", z * 100.).into();
        let sel_label: SharedString = format!("{} selected", c.selected.len()).into();
        let root = div()
            .id("canvas")
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(rgb(0x0b0b0d))
            .text_color(gpui::white())
            .text_sm()
            .children(cards)
            .children(marquee)
            .on_mouse_down(MouseButton::Left, cx.listener(|this, e: &MouseDownEvent, _, cx| {
                this.canvas.press(pt(e.position), e.modifiers.shift);
                cx.notify();
            }))
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                if this.canvas.gesture != Gesture::Idle {
                    this.canvas.drag(pt(e.position));
                    cx.notify();
                }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| {
                this.canvas.release();
                cx.notify();
            }))
            .on_scroll_wheel(cx.listener(|this, e: &ScrollWheelEvent, _, cx| {
                let d = e.delta.pixel_delta(px(20.));
                let (dx, dy) = (f32::from(d.x), f32::from(d.y));
                if e.modifiers.control || e.modifiers.platform {
                    this.canvas.zoom_at(pt(e.position), (dy / 200.).exp());
                } else {
                    this.canvas.scroll(dx, dy);
                }
                cx.notify();
            }))
            // Tabs (top), toolbar (bottom), library + zoom pills (corners).
            .child(
                div().absolute().top_3().left_0().right_0().flex().justify_center().child(
                    Self::glass().flex().p_1().gap_1().children(tabs.into_iter().enumerate().map(|(i, t)| {
                        div()
                            .id(("tab", i))
                            .px_3()
                            .py_1()
                            .rounded_full()
                            .when(i == self.tab, |d| d.bg(rgba(0xffffff2a)))
                            .child(t)
                            .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                                cx.stop_propagation();
                                this.tab = i;
                                cx.notify();
                            }))
                    })),
                ),
            )
            .child(div().absolute().bottom_4().left_0().right_0().flex().justify_center().child(self.toolbar(cx)))
            .child(div().absolute().bottom_4().left_4().child(Self::glass().px_3().py_2().child("▣ library")))
            .child(
                div()
                    .absolute()
                    .bottom_4()
                    .right_4()
                    .flex()
                    .gap_2()
                    .child(Self::glass().px_3().py_2().child(sel_label))
                    .child(Self::glass().px_3().py_2().child(zoom_label)),
            );
        let build = t0.elapsed();
        if build > Duration::from_millis(4) {
            println!("SLOW render build {:?}", build);
        }
        root
    }
}

fn pt(v: gpui::Point<gpui::Pixels>) -> P {
    p(f32::from(v.x), f32::from(v.y))
}

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::new(point(px(0.), px(0.)), size(px(W), px(H)));
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions { title: Some("canvas-spike".into()), appears_transparent: true, ..Default::default() }),
                window_background: WindowBackgroundAppearance::Blurred,
                ..Default::default()
            },
            |_, cx| {
                cx.new(|cx| {
                    let mut b = Board::new();
                    if std::env::var_os("CANVAS_SPIKE_SCRIPT").is_some() {
                        b.run_script(cx);
                    }
                    b
                })
            },
        )
        .unwrap();
        cx.activate(false);
    });
}
