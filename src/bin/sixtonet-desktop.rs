// SPDX-License-Identifier: AGPL-3.0-only
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(all(windows, feature = "sixtonet"))]
struct DesktopProcess {
    process: winapi::shared::ntdef::HANDLE,
    job: winapi::shared::ntdef::HANDLE,
}

#[cfg(all(windows, feature = "sixtonet"))]
impl Drop for DesktopProcess {
    fn drop(&mut self) {
        unsafe {
            winapi::um::processthreadsapi::TerminateProcess(self.process, 0);
            winapi::um::handleapi::CloseHandle(self.process);
            if !self.job.is_null() {
                winapi::um::handleapi::CloseHandle(self.job);
            }
        }
    }
}

#[cfg(all(windows, feature = "sixtonet"))]
fn main() {
    // Same process DPI setup as upstream src/main.rs, before any display or
    // input APIs run. Windows can already have set it through the manifest.
    unsafe {
        winapi::um::shellscalingapi::SetProcessDpiAwareness(2);
    }
    if let Err(error) = run() {
        eprintln!("SixtoNet desktop: {error}");
        std::process::exit(1);
    }
}

#[cfg(all(windows, feature = "sixtonet"))]
fn run() -> hbb_common::ResultType<()> {
    use hbb_common::{bail, tokio};
    use librustdesk::sixtonet;
    use std::{path::PathBuf, time::Duration};
    use winapi::um::{
        jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject},
        synchapi::WaitForSingleObject,
        winnt::{
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };
    extern "C" {
        fn is_local_system() -> i32;
    }
    if unsafe { is_local_system() } == 0 {
        bail!("the desktop adapter must be launched by the SYSTEM agent");
    }
    let root = PathBuf::from(std::env::var("ProgramData")?)
        .join("SixtoNet")
        .join("desktop");
    let config = sixtonet::read_config(&root.join("session.json"))?;
    validate_user_session(&config)?;
    if std::env::args().nth(1).as_deref() == Some("--server") {
        if config.unattended_console && !config.input && !config.clipboard && !config.audio {
            // Diagnostics must not prevent support if the log cannot be opened.
            let _ = sixtonet::capture_diagnostics(&root.join("capture-unattended.log"));
        }
        if librustdesk::platform::windows::get_current_process_session_id() != Some(config.windows_session_id) {
            bail!("capture process is not in the selected Windows user session");
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(sixtonet::serve(config));
        // Media threads belong to this one grant, never a persistent service.
        if let Err(ref error) = result {
            let _ = std::fs::write(root.join("last-error.txt"), error.to_string());
        }
        return result;
    }
    // The SYSTEM agent selects an existing user or explicit console session. This does not
    // create a login, transfer the user, disconnect RDP or unlock Windows.
    let session_id = config.windows_session_id;
    if session_id == u32::MAX {
        bail!("Windows has no interactive desktop session");
    }
    let exe = std::env::current_exe()?;
    let cmd = format!("\"{}\" --server", exe.display());
    let handle = librustdesk::platform::windows::launch_privileged_process(session_id, &cmd)?;
    if handle.is_null() {
        bail!("could not start the active desktop process");
    }
    // The OS owns cleanup even if the parent crashes. A child desktop process
    // must not survive an agent/service shutdown just because no finally ran.
    let mut owned = DesktopProcess {
        process: handle,
        job: std::ptr::null_mut(),
    };
    unsafe {
        owned.job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if owned.job.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            owned.job,
            JobObjectExtendedLimitInformation,
            &mut limits as *mut _ as *mut _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(owned.job, handle) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    let deadline = config.expires_at;
    while sixtonet::now().map(|now| now < deadline).unwrap_or(false)
        && root.join("session.json").exists()
    {
        // User sessions end on logout/disconnect; console sessions stay bound to the same console ID.
        if validate_user_session(&config).is_err() { break; }
        let status = unsafe { WaitForSingleObject(handle, 200) };
        if status == 0 {
            break;
        }
        if status != 258 {
            break;
        }
    }
    let mut child_exit = 0u32;
    unsafe {
        // The stream may close just before Windows signals process termination.
        WaitForSingleObject(handle, 200);
        winapi::um::processthreadsapi::GetExitCodeProcess(handle, &mut child_exit);
    }
    drop(owned);
    if child_exit == 74 { std::process::exit(74); }
    std::thread::sleep(Duration::from_millis(50));
    Ok(())
}

#[cfg(not(all(windows, feature = "sixtonet")))]
fn main() {
    eprintln!("This adapter requires Windows and --features sixtonet.");
    std::process::exit(1);
}

#[cfg(all(windows, feature = "sixtonet"))]
fn validate_user_session(cfg: &librustdesk::sixtonet::SessionConfig) -> hbb_common::ResultType<()> {
    if cfg.unattended_console {
        #[link(name = "Kernel32")]
        extern "system" { fn WTSGetActiveConsoleSessionId() -> u32; }
        let current = unsafe { WTSGetActiveConsoleSessionId() };
        if !matches_console(cfg.windows_session_id, current) {
            hbb_common::bail!("selected Windows console changed or is unavailable");
        }
        return Ok(());
    }
    // winapi 0.3's wtsapi32 module has no bindings for these functions.
    #[link(name = "Wtsapi32")]
    extern "system" {
        fn WTSQuerySessionInformationW(server: winapi::shared::ntdef::HANDLE, session: u32,
            info: i32, value: *mut *mut u16, bytes: *mut u32) -> i32;
        fn WTSFreeMemory(value: *mut std::ffi::c_void);
    }
    const WTS_CONNECT_STATE: i32 = 8;
    const WTS_USER_NAME: i32 = 5;
    const WTS_DOMAIN_NAME: i32 = 7;
    unsafe {
        let mut value: *mut u16 = std::ptr::null_mut();
        let mut size = 0;
        if WTSQuerySessionInformationW(std::ptr::null_mut(), cfg.windows_session_id,
            WTS_CONNECT_STATE, &mut value, &mut size) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let active = size >= 4 && !value.is_null() && *(value as *const u32) == 0;
        WTSFreeMemory(value as _);
        if !active { hbb_common::bail!("selected Windows user session is not active"); }
        if WTSQuerySessionInformationW(std::ptr::null_mut(), cfg.windows_session_id,
            WTS_USER_NAME, &mut value, &mut size) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let name = if value.is_null() || size < 2 { String::new() } else {
            let units = std::slice::from_raw_parts(value, size as usize / 2);
            let end = units.iter().position(|v| *v == 0).unwrap_or(units.len());
            String::from_utf16_lossy(&units[..end])
        };
        WTSFreeMemory(value as _);
        if name != cfg.windows_username { hbb_common::bail!("selected Windows user changed"); }
        if WTSQuerySessionInformationW(std::ptr::null_mut(), cfg.windows_session_id,
            WTS_DOMAIN_NAME, &mut value, &mut size) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let domain = if value.is_null() || size < 2 { String::new() } else {
            let units = std::slice::from_raw_parts(value, size as usize / 2);
            let end = units.iter().position(|v| *v == 0).unwrap_or(units.len());
            String::from_utf16_lossy(&units[..end])
        };
        WTSFreeMemory(value as _);
        if domain != cfg.windows_domain { hbb_common::bail!("selected Windows domain changed"); }

    }
    Ok(())
}

#[cfg(any(test, all(windows, feature = "sixtonet")))]
fn matches_console(selected: u32, current: u32) -> bool {
    selected != 0 && selected != u32::MAX && selected == current
}

#[cfg(test)]
mod console_session_tests {
    use super::matches_console;

    #[test]
    fn permits_only_the_exact_non_service_console() {
        assert!(matches_console(1, 1));
        assert!(matches_console(7, 7));
        assert!(!matches_console(0, 0));
        assert!(!matches_console(u32::MAX, u32::MAX));
        assert!(!matches_console(1, 2));
        assert!(!matches_console(1, u32::MAX));
    }
}