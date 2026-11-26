use std::fs;
use std::path::Path;

/// [`write_file_secure`] through a sibling temporary file and a rename, so a
/// concurrent reader sees either the old content or the new, never a truncated
/// file. For files another thread may read while they are rewritten (profiles
/// during an encryption batch).
///
/// The temporary file is secured before it replaces `path`, so `Err` always
/// means `path` still holds its old content: a failed permission step removes
/// the temporary file instead of publishing it. The owner-only DACL set on
/// Windows travels with the file through the rename.
pub fn write_file_secure_atomic(path: &Path, content: &str) -> Result<(), String> {
    // Hidden, and not ending in `.yaml`, so profile listings and the batches
    // never pick up a leftover from a crash. Unique per write so two writers to
    // the same path cannot interleave in one temporary file. Opaque rather than
    // derived from the destination name: a profile name may already use the
    // whole 255-byte file name limit, leaving no room for a suffix.
    let tmp = path.with_file_name(format!(
        ".zephyr-write-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(e) = write_new_private_file(&tmp, content) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Failed to write to {path:?}: {e}"));
    }
    #[cfg(not(target_os = "windows"))]
    if let Err(e) = restrict_permissions(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = rename_replacing(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Failed to write to {path:?}: {e}"));
    }
    // The rename is only durable once the directory entry is: without this a
    // crash can bring the old file back after the caller was told it was saved.
    #[cfg(unix)]
    if let Some(dir) = path.parent().and_then(|p| fs::File::open(p).ok()) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// `fs::rename` over an existing file, retried briefly.
///
/// On Windows the replace fails with access denied while another process
/// (antivirus, the search indexer) holds the destination open without
/// `FILE_SHARE_DELETE`. Such handles are transient, so three attempts 50 ms
/// apart ride them out; the last error is returned.
pub fn rename_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut result = fs::rename(from, to);
    for _ in 0..2 {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        result = fs::rename(from, to);
    }
    result
}

/// Create `path` (which must not exist) and write `content`, durably.
///
/// On Unix the file is created with mode 0600. On Windows it is opened
/// exclusively and its private DACL is installed before any content is written.
/// `sync_all` makes the data durable before the caller publishes the file.
fn write_new_private_file(path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Foundation::GENERIC_WRITE;
        use windows_sys::Win32::Storage::FileSystem::{READ_CONTROL, WRITE_DAC};
        // No other reader can retain an empty-file handle before the DACL is
        // installed. Apply the ACL on this same handle before writing secrets.
        opts.access_mode(GENERIC_WRITE | READ_CONTROL | WRITE_DAC)
            .share_mode(0);
    }
    let mut file = opts.open(path)?;
    #[cfg(target_os = "windows")]
    restrict_open_file(&file).map_err(std::io::Error::other)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()
}

/// Write a file with restricted permissions (owner-only, equivalent to Unix 0600).
///
/// On Unix: replaces with mode 0600.
/// On Windows: replaces with a file secured for current user + SYSTEM before writing.
///
/// Unix and Windows secure the replacement before publication. A later
/// path-based permission change must not follow a retargeted symbolic link.
pub fn write_file_secure(path: &Path, content: &str) -> Result<(), String> {
    write_owner_only(path, content).map_err(|e| format!("Failed to write to {path:?}: {e}"))?;
    #[cfg(not(any(unix, target_os = "windows")))]
    restrict_permissions(path)?;
    Ok(())
}

/// Replace the file so descriptors opened before permission repair cannot read
/// newly written private content through an older readable handle.
fn write_owner_only(path: &Path, content: &str) -> std::io::Result<()> {
    #[cfg(any(unix, target_os = "windows"))]
    {
        // Preserve write-through behavior for an existing symbolic link, while
        // replacing its target inode so old descriptors cannot see new secrets.
        let is_symlink = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata.file_type().is_symlink(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error),
        };
        let target = if is_symlink {
            fs::canonicalize(path)?
        } else {
            path.to_path_buf()
        };
        write_file_secure_atomic(&target, content).map_err(std::io::Error::other)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        fs::write(path, content)
    }
}

/// Apply owner-only permissions before atomic publication.
#[cfg(not(target_os = "windows"))]
fn restrict_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to set permissions on {path:?}: {e}"))?;
    }

    Ok(())
}

/// Apply the private DACL through an already-owned file handle.
#[cfg(target_os = "windows")]
fn restrict_open_file(file: &fs::File) -> Result<(), String> {
    // On Windows, use explicit ACL to restrict file access to current user only
    // This is equivalent to Unix 0600 permissions
    use std::os::windows::io::AsRawHandle as _;
    use std::ptr;
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_SUCCESS, GENERIC_ALL, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetSecurityInfo, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT,
        TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_IS_WELL_KNOWN_GROUP,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, GetTokenInformation, TokenUser, WinLocalSystemSid, ACL,
        DACL_SECURITY_INFORMATION, NO_INHERITANCE, PROTECTED_DACL_SECURITY_INFORMATION, PSID,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: This block calls Windows security APIs to set file DACL.
    // All pointer parameters are obtained from valid Windows API calls.
    // The operations are logically atomic — partial failure is handled by early returns.
    #[allow(clippy::multiple_unsafe_ops_per_block)]
    unsafe {
        let handle = file.as_raw_handle();

        // Get current process token to find the user
        let mut token_handle: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_handle) == 0 {
            return Err(
                "[SECURITY] Failed to open process token — file permissions may be insecure"
                    .to_owned(),
            );
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
            return Err(
                "[SECURITY] Failed to get token user info — file permissions may be insecure"
                    .to_owned(),
            );
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
            return Err(
                "[SECURITY] Failed to create SYSTEM SID — file permissions may be insecure"
                    .to_owned(),
            );
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
            return Err(
                "[SECURITY] Failed to create ACL — file permissions may be insecure".to_owned(),
            );
        }

        // Apply the security descriptor to the file
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
            return Err(
                "Failed to set file security info — file may have insecure permissions".to_owned(),
            );
        }

        LocalFree(new_acl as *mut _);
    }

    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Read as _;
    use std::os::unix::fs::PermissionsExt as _;

    #[test]
    fn staging_file_is_private_without_later_permission_normalization() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.tmp");
        write_new_private_file(&path, "secret").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0);
        assert_eq!(fs::read_to_string(&path).unwrap(), "secret");
    }

    #[test]
    fn owner_only_writer_secures_existing_files_and_truncates_old_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.yaml");
        fs::write(&path, "previous content that is longer").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        // Check the published replacement's final mode and contents.
        write_owner_only(&path, "secret").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "secret");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn owner_only_writer_does_not_publish_secrets_through_old_descriptors() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.yaml");
        fs::write(&path, "old public content").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let mut old_descriptor = fs::File::open(&path).unwrap();
        write_owner_only(&path, "new private secret").unwrap();
        let mut old_content = String::new();
        old_descriptor.read_to_string(&mut old_content).unwrap();
        assert_eq!(old_content, "old public content");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new private secret");
    }

    #[test]
    fn owner_only_writer_preserves_existing_symbolic_link() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("profile.yaml");
        let alias = directory.path().join("alias.yaml");
        fs::write(&target, "old profile").unwrap();
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        write_owner_only(&alias, "new profile").unwrap();
        assert!(fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new profile");
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;
    use std::io::Read as _;

    #[test]
    fn secure_writer_replaces_the_old_readable_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.yaml");
        fs::write(&path, "old public content").unwrap();
        let mut old_descriptor = fs::File::open(&path).unwrap();
        write_file_secure(&path, "new private secret").unwrap();
        let mut old_content = String::new();
        old_descriptor.read_to_string(&mut old_content).unwrap();
        assert_eq!(old_content, "old public content");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new private secret");
    }
}
