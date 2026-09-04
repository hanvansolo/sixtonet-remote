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
    if std::env::args().nth(1).as_deref() == Some("--server") {
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
    let session_id = librustdesk::platform::windows::get_current_session_id(false);
    if session_id == u32::MAX {
        bail!("Windows has no physical console session");
    }
    let exe = std::env::current_exe()?;
    let cmd = format!("\"{}\" --server", exe.display());
    let handle = librustdesk::platform::windows::launch_privileged_process(session_id, &cmd)?;
    if handle.is_null() {
        bail!("could not start the physical desktop process");
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
        let status = unsafe { WaitForSingleObject(handle, 200) };
        if status == 0 {
            break;
        }
        if status != 258 {
            break;
        }
    }
    drop(owned);
    std::thread::sleep(Duration::from_millis(50));
    Ok(())
}

#[cfg(not(all(windows, feature = "sixtonet")))]
fn main() {
    eprintln!("This adapter requires Windows and --features sixtonet.");
    std::process::exit(1);
}
