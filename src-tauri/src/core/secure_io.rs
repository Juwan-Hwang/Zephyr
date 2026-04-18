use std::fs;
use std::path::Path;

pub fn write_file_secure(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("Failed to write to {path:?}: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, use explicit ACL to restrict file access to current user only
        // This is equivalent to Unix 0600 permissions
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt as _;
        use std::ptr;
        use windows_sys::Win32::Foundation::{
            CloseHandle, GENERIC_ALL, HANDLE, ERROR_SUCCESS, INVALID_HANDLE_VALUE, LocalFree,
        };
        use windows_sys::Win32::Security::Authorization::{
            EXPLICIT_ACCESS_W, GRANT_ACCESS, SetEntriesInAclW, SetSecurityInfo, SE_FILE_OBJECT,
            TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_IS_WELL_KNOWN_GROUP,
        };
        use windows_sys::Win32::Security::{
            ACL, DACL_SECURITY_INFORMATION, CreateWellKnownSid, GetTokenInformation,
            NO_INHERITANCE, PSID, PROTECTED_DACL_SECURITY_INFORMATION,
            TOKEN_QUERY, TOKEN_USER, TokenUser, WinLocalSystemSid,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
            READ_CONTROL, WRITE_DAC,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        // Convert path to wide string
        let wide_path: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // SAFETY: This block calls Windows security APIs to set file DACL.
        // All pointer parameters are obtained from valid Windows API calls.
        // The operations are logically atomic — partial failure is handled by early returns.
        #[allow(clippy::multiple_unsafe_ops_per_block)]
        unsafe {
            // Get a handle to the file with WRITE_DAC access
            let handle = CreateFileW(
                wide_path.as_ptr(),
                WRITE_DAC | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null_mut(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            );

            if handle == INVALID_HANDLE_VALUE {
                #[cfg(debug_assertions)]
                eprintln!("[SECURITY] Failed to open file for DACL modification");
                return Ok(()); // Non-fatal: file was written, just permissions not set
            }

            // Get current process token to find the user
            let mut token_handle: HANDLE = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_handle) == 0 {
                CloseHandle(handle);
                #[cfg(debug_assertions)]
                eprintln!("[SECURITY] Failed to open process token");
                return Ok(());
            }

            // Get token user info size
            let mut size: u32 = 0;
            GetTokenInformation(
                token_handle,
                TokenUser,
                std::ptr::null_mut::<std::ffi::c_void>(),
                0,
                &mut size,
            );

            // Allocate buffer and get token user
            let mut buffer: Vec<u8> = vec![0u8; size as usize];
            if GetTokenInformation(
                token_handle,
                TokenUser,
                buffer.as_mut_ptr() as *mut std::ffi::c_void,
                size,
                &mut size,
            ) == 0
            {
                CloseHandle(token_handle);
                CloseHandle(handle);
                #[cfg(debug_assertions)]
                eprintln!("[SECURITY] Failed to get token user info");
                return Ok(());
            }

            let token_user = &*(buffer.as_ptr() as *const TOKEN_USER);

            // Build explicit access entries: current user + SYSTEM
            let mut ea: [EXPLICIT_ACCESS_W; 2] = [std::mem::zeroed(), std::mem::zeroed()];

            // Entry 0: Current user with full access
            ea[0].grfAccessPermissions = GENERIC_ALL;
            ea[0].grfAccessMode = GRANT_ACCESS;
            ea[0].grfInheritance = NO_INHERITANCE;
            ea[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
            ea[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
            ea[0].Trustee.ptstrName = token_user.User.Sid as *mut _;

            // Entry 1: SYSTEM account with full access (required for services)
            // Get SYSTEM SID
            let mut sid_size: u32 = 0;

            // First call to get size
            CreateWellKnownSid(
                WinLocalSystemSid,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut sid_size,
            );

            // Allocate buffer for SYSTEM SID
            let mut system_sid_buffer: Vec<u8> = vec![0u8; sid_size as usize];
            let system_sid: PSID = system_sid_buffer.as_mut_ptr() as PSID;

            if CreateWellKnownSid(
                WinLocalSystemSid,
                ptr::null_mut(),
                system_sid,
                &mut sid_size,
            ) == 0
            {
                CloseHandle(token_handle);
                CloseHandle(handle);
                #[cfg(debug_assertions)]
                eprintln!("[SECURITY] Failed to create SYSTEM SID");
                return Ok(());
            }

            ea[1].grfAccessPermissions = GENERIC_ALL;
            ea[1].grfAccessMode = GRANT_ACCESS;
            ea[1].grfInheritance = NO_INHERITANCE;
            ea[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
            ea[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
            ea[1].Trustee.ptstrName = system_sid as *mut _;

            CloseHandle(token_handle);

            // Create a new ACL with both entries
            let mut new_acl: *mut ACL = ptr::null_mut();
            if SetEntriesInAclW(2, ea.as_ptr(), ptr::null_mut(), &mut new_acl) != ERROR_SUCCESS {
                CloseHandle(handle);
                #[cfg(debug_assertions)]
                eprintln!("[SECURITY] Failed to create ACL");
                return Ok(());
            }

            // Apply the security descriptor to the file
            // SetSecurityInfo returns ERROR_SUCCESS (0) on success, non-zero on failure
            if SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                new_acl,
                ptr::null_mut(),
            ) != 0
            {
                LocalFree(new_acl as *mut _);
                CloseHandle(handle);
                // Security issue - file written with insecure permissions
                eprintln!("[SECURITY] WARNING: Failed to set file security info - file may have insecure permissions");
                return Ok(());
            }

            LocalFree(new_acl as *mut _);
            CloseHandle(handle);

            // Note: Windows administrators can always take ownership of files.
            // This is equivalent to Unix 0600 - protects against regular users,
            // not against privileged accounts.
            #[cfg(debug_assertions)]
            eprintln!("[SECURITY] Successfully set file permissions (owner-only, equivalent to Unix 0600)");
        }
    }

    Ok(())
}
