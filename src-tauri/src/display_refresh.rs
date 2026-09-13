//! Display-refresh probe for the window's screen.
//!
//! The webview compositor (Core Animation/Metal on macOS, EGL/WebKitGTK on
//! Linux, D3D/WebView2 on Windows) vsyncs independently of JavaScript. This
//! command reports the OS-advertised Hertz so the JS frame pipeline can tell
//! "panel is 540 Hz" from "WKWebView capped rAF at 60".

use serde::Serialize;
use tauri::WebviewWindow;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DisplayRefreshInfo {
    pub native_hz: Option<f64>,
    pub scale_factor: Option<f64>,
    pub compositor: &'static str,
    pub gpu_backend: &'static str,
}

impl Default for DisplayRefreshInfo {
    fn default() -> Self {
        let (compositor, gpu_backend) = compositor_for(std::env::consts::OS);
        Self {
            native_hz: None,
            scale_factor: None,
            compositor,
            gpu_backend,
        }
    }
}

pub(crate) fn compositor_for(os: &str) -> (&'static str, &'static str) {
    match os {
        "macos" => ("core-animation", "metal"),
        "linux" => ("webkitgtk", "egl"),
        "windows" => ("webview2", "d3d"),
        _ => ("browser", "unknown"),
    }
}

#[tauri::command]
pub fn get_display_refresh(window: WebviewWindow) -> DisplayRefreshInfo {
    #[cfg(target_os = "macos")]
    {
        return read_macos_screen(&window);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        DisplayRefreshInfo::default()
    }
}

#[cfg(target_os = "macos")]
fn read_macos_screen(window: &WebviewWindow) -> DisplayRefreshInfo {
    let fallback = DisplayRefreshInfo::default();
    let ptr = match window.ns_window() {
        Ok(p) if !p.is_null() => p as usize,
        _ => return fallback,
    };
    run_on_main_thread(move || unsafe { read_nsscreen(ptr as *mut std::ffi::c_void) })
}

#[cfg(target_os = "macos")]
unsafe fn read_nsscreen(ns_window: *mut std::ffi::c_void) -> DisplayRefreshInfo {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let mut info = DisplayRefreshInfo::default();
    let window = ns_window as *mut AnyObject;
    if window.is_null() {
        return info;
    }
    let screen: *mut AnyObject = msg_send![window, screen];
    if screen.is_null() {
        return info;
    }
    let hz: isize = msg_send![screen, maximumFramesPerSecond];
    if hz > 0 {
        info.native_hz = Some(hz as f64);
    }
    let scale: f64 = msg_send![screen, backingScaleFactor];
    if scale.is_finite() && scale > 0.0 {
        info.scale_factor = Some(scale);
    }
    info
}

#[cfg(target_os = "macos")]
extern "C" {
    static _dispatch_main_q: std::ffi::c_void;
    fn dispatch_sync_f(
        queue: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
        work: extern "C" fn(*mut std::ffi::c_void),
    );
    fn pthread_main_np() -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn run_on_main_thread<F, R>(work: F) -> R
where
    F: FnOnce() -> R,
    R: Default,
{
    if unsafe { pthread_main_np() } != 0 {
        return work();
    }

    struct Ctx<F, R> {
        work: Option<F>,
        result: Option<R>,
    }

    extern "C" fn trampoline<F, R>(ctx_ptr: *mut std::ffi::c_void)
    where
        F: FnOnce() -> R,
    {
        let ctx = unsafe { &mut *(ctx_ptr as *mut Ctx<F, R>) };
        if let Some(f) = ctx.work.take() {
            ctx.result = Some(f());
        }
    }

    let mut ctx = Ctx::<F, R> {
        work: Some(work),
        result: None,
    };
    unsafe {
        dispatch_sync_f(
            &_dispatch_main_q as *const _ as *mut _,
            &mut ctx as *mut Ctx<F, R> as *mut _,
            trampoline::<F, R>,
        );
    }
    ctx.result.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::compositor_for;

    #[test]
    fn macos_uses_core_animation_metal() {
        assert_eq!(compositor_for("macos"), ("core-animation", "metal"));
    }

    #[test]
    fn linux_uses_webkitgtk_egl() {
        assert_eq!(compositor_for("linux"), ("webkitgtk", "egl"));
    }

    #[test]
    fn windows_uses_webview2_d3d() {
        assert_eq!(compositor_for("windows"), ("webview2", "d3d"));
    }
}
