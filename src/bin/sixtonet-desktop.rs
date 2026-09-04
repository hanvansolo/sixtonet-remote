// SPDX-License-Identifier: AGPL-3.0-only
#![cfg_attr(windows, windows_subsystem = "windows")]

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
        handleapi::CloseHandle, processthreadsapi::TerminateProcess, synchapi::WaitForSingleObject,
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
    let deadline = config.expires_at;
    while sixtonet::now()? < deadline && root.join("session.json").exists() {
        let status = unsafe { WaitForSingleObject(handle, 200) };
        if status == 0 {
            break;
        }
        if status != 258 {
            break;
        }
    }
    unsafe {
        TerminateProcess(handle, 0);
        CloseHandle(handle);
    }
    std::thread::sleep(Duration::from_millis(50));
    Ok(())
}

#[cfg(not(all(windows, feature = "sixtonet")))]
fn main() {
    eprintln!("This adapter requires Windows and --features sixtonet.");
    std::process::exit(1);
}
