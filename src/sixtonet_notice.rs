// SPDX-License-Identifier: AGPL-3.0-only
//! Visible indicator owned by the one-grant desktop child, never a technician app.
use std::sync::atomic::{AtomicBool, Ordering};
static CONNECTED: AtomicBool = AtomicBool::new(false);
pub fn connected() { CONNECTED.store(true, Ordering::Release); }

#[cfg(windows)]
pub fn start(operator: &str, input: bool) -> hbb_common::ResultType<()> {
    use std::{ptr::null_mut, sync::mpsc, time::Duration};
    use winapi::{shared::windef::HWND, um::{libloaderapi::GetModuleHandleW, winuser::*}};
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
    unsafe fn compact(hwnd: HWND, small: bool) {
        let label = GetDlgItem(hwnd, 2);
        ShowWindow(label, if small { SW_HIDE } else { SW_SHOWNOACTIVATE });
        SetWindowPos(hwnd, null_mut(), 0, 0, if small { 390 } else { 560 },
            if small { 90 } else { 145 }, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        MoveWindow(GetDlgItem(hwnd, 1), 12, if small { 8 } else { 60 }, 220, 28, 1);
        MoveWindow(GetDlgItem(hwnd, 3), 244, if small { 8 } else { 60 }, 120, 28, 1);
        SetWindowTextW(GetDlgItem(hwnd, 3), wide(if small { "Show details" } else { "Collapse" }).as_ptr());
    }
    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: usize, l: isize) -> isize {
        match msg {
            WM_TIMER => {
                if CONNECTED.load(Ordering::Acquire) { ShowWindow(hwnd, SW_SHOWNOACTIVATE); }
                0
            }
            WM_COMMAND if w & 0xffff == 1 => { std::process::exit(74); }
            WM_COMMAND if w & 0xffff == 3 => { compact(hwnd, IsWindowVisible(GetDlgItem(hwnd, 2)) != 0); 0 }
            WM_CLOSE => { compact(hwnd, true); 0 }
            _ => DefWindowProcW(hwnd, msg, w, l),
        }
    }
    let operator: String = operator.chars().filter(|c| !c.is_control()).take(200).collect();
    let text = format!("{}\r\n{}", operator, if input { "Screen sharing - keyboard and mouse permitted" } else { "Screen sharing - view only" });
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || unsafe {
        let instance = GetModuleHandleW(null_mut());
        let name = wide("SixtoNetSupportNotice");
        let mut cls: WNDCLASSW = std::mem::zeroed();
        cls.lpfnWndProc = Some(proc); cls.hInstance = instance; cls.lpszClassName = name.as_ptr();
        cls.hbrBackground = (COLOR_WINDOW + 1) as _;
        if RegisterClassW(&cls) == 0 { let _ = tx.send(false); return; }
        let hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            name.as_ptr(), wide("SixtoNet Support connected").as_ptr(), WS_CAPTION | WS_SYSMENU,
            20, 20, 560, 145, null_mut(), null_mut(), instance, null_mut());
        if hwnd.is_null() { let _ = tx.send(false); return; }
        let label = CreateWindowExW(0, wide("STATIC").as_ptr(), wide(&text).as_ptr(), WS_CHILD | WS_VISIBLE,
            12, 8, 530, 45, hwnd, 2 as _, instance, null_mut());
        let button = CreateWindowExW(0, wide("BUTTON").as_ptr(), wide("End support session").as_ptr(), WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            12, 60, 220, 28, hwnd, 1 as _, instance, null_mut());
        let collapse = CreateWindowExW(0, wide("BUTTON").as_ptr(), wide("Collapse").as_ptr(), WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            244, 60, 120, 28, hwnd, 3 as _, instance, null_mut());
        if collapse.is_null() || label.is_null() || button.is_null() || SetTimer(hwnd, 1, 250, None) == 0 {
            DestroyWindow(hwnd); let _ = tx.send(false); return;
        }
        if tx.send(true).is_err() { DestroyWindow(hwnd); return; }
        let mut msg: MSG = std::mem::zeroed();
        loop {
            let status = GetMessageW(&mut msg, null_mut(), 0, 0);
            if status <= 0 { break; }
            TranslateMessage(&msg); DispatchMessageW(&msg);
        }
        // Loss of the indicator ends this one-grant child, not the endpoint agent.
        std::process::exit(0);
    });
    if rx.recv_timeout(Duration::from_secs(5)) != Ok(true) {
        hbb_common::bail!("could not create the user-visible support notice");
    }
    Ok(())
}
