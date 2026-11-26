//! Rule Group management and settings commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use crate::prism::types::{
    check_name_size, read_groups, read_prism_settings, sanitize_filename, write_groups,
    write_prism_settings, RuleGroup, RuleGroups,
};
use crate::prism::PrismState;

async fn update_groups(
    prism_dir: std::path::PathBuf,
    update: impl FnOnce(&mut RuleGroups) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // File deletion and rename update these references under the same lock.
        let _files = super::rule_library::lock_rule_files()?;
        let mut groups = read_groups(&prism_dir)?;
        update(&mut groups)?;
        write_groups(&prism_dir, &groups)
    })
    .await
    .map_err(|error| format!("Rule group save task failed: {error}"))?
}

#[tauri::command]
pub fn rule_group_list(state: State<PrismState>) -> Result<RuleGroups, String> {
    let prism_dir = state.get_prism_workspace()?;
    read_groups(&prism_dir)
}

#[tauri::command]
pub async fn rule_group_create(state: State<'_, PrismState>, name: String) -> Result<(), String> {
    // Security: Validate group name input size to prevent DoS
    check_name_size(&name, "Group name")?;
    let prism_dir = state.get_prism_workspace()?;
    update_groups(prism_dir, move |groups| {
        if groups.groups.iter().any(|g| g.name == name) {
            return Err(format!("Group '{name}' already exists"));
        }
        groups.groups.push(RuleGroup {
            name,
            files: Vec::new(),
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn rule_group_rename(
    state: State<'_, PrismState>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    // Security: Only the new name is size-checked (it is what gets stored).
    // The old name is a pure lookup, so an oversized group stored by an
    // older version can still be renamed away.
    check_name_size(&new_name, "Group name")?;
    let prism_dir = state.get_prism_workspace()?;
    update_groups(prism_dir, move |groups| {
        // Check new_name doesn't already exist before mutably borrowing.
        let old_idx = groups
            .groups
            .iter()
            .position(|g| g.name == old_name)
            .ok_or_else(|| format!("Group '{old_name}' not found"))?;
        if groups.groups.iter().any(|g| g.name == new_name) {
            return Err(format!("Group '{new_name}' already exists"));
        }
        if let Some(group) = groups.groups.get_mut(old_idx) {
            group.name = new_name;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn rule_group_delete(state: State<'_, PrismState>, name: String) -> Result<(), String> {
    // No size check: deleting must always work, even for a group whose
    // oversized name was stored by an older version.
    let prism_dir = state.get_prism_workspace()?;
    update_groups(prism_dir, move |groups| {
        let before = groups.groups.len();
        groups.groups.retain(|g| g.name != name);
        if groups.groups.len() == before {
            return Err(format!("Group '{name}' not found"));
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn rule_group_move(
    state: State<'_, PrismState>,
    filename: String,
    target_group: Option<String>,
) -> Result<(), String> {
    let prism_dir = state.get_prism_workspace()?;
    let safe = sanitize_filename(&filename)?;
    update_groups(prism_dir, move |groups| {
        // Remove file from all groups first.
        for group in &mut groups.groups {
            group.files.retain(|f| f != &safe);
        }
        // If a target group is specified, add the file to it.
        if let Some(group_name) = &target_group {
            let group = groups
                .groups
                .iter_mut()
                .find(|g| g.name == *group_name)
                .ok_or_else(|| format!("Group '{group_name}' not found"))?;
            if !group.files.contains(&safe) {
                group.files.push(safe);
            }
        }
        Ok(())
    })
    .await
}

// ===========================================================================
// Rule Library: Settings
// ===========================================================================

#[tauri::command]
pub fn rule_get_auto_apply(state: State<PrismState>) -> Result<bool, String> {
    let prism_dir = state.get_prism_workspace()?;
    let settings = read_prism_settings(&prism_dir)?;
    Ok(settings.auto_apply)
}

#[tauri::command]
pub fn rule_set_auto_apply(state: State<PrismState>, enabled: bool) -> Result<(), String> {
    let prism_dir = state.get_prism_workspace()?;
    let mut settings = read_prism_settings(&prism_dir)?;
    settings.auto_apply = enabled;
    write_prism_settings(&prism_dir, &settings)
}
