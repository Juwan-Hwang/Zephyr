//! Rule Group management and settings commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use crate::prism::types::{
    read_groups, read_prism_settings, sanitize_filename, write_groups, write_prism_settings,
    RuleGroup, RuleGroups,
};
use crate::prism::PrismState;

#[tauri::command]
pub fn rule_group_list(state: State<PrismState>) -> Result<RuleGroups, String> {
    let prism_dir = state.get_prism_workspace()?;
    read_groups(&prism_dir)
}

#[tauri::command]
pub fn rule_group_create(state: State<PrismState>, name: String) -> Result<(), String> {
    let prism_dir = state.get_prism_workspace()?;
    let mut groups = read_groups(&prism_dir)?;

    if groups.groups.iter().any(|g| g.name == name) {
        return Err(format!("Group '{name}' already exists"));
    }

    groups.groups.push(RuleGroup {
        name,
        files: Vec::new(),
    });
    write_groups(&prism_dir, &groups)
}

#[tauri::command]
pub fn rule_group_rename(
    state: State<PrismState>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let prism_dir = state.get_prism_workspace()?;
    let mut groups = read_groups(&prism_dir)?;

    // Check new_name doesn't already exist before mutably borrowing
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
    write_groups(&prism_dir, &groups)
}

#[tauri::command]
pub fn rule_group_delete(state: State<PrismState>, name: String) -> Result<(), String> {
    let prism_dir = state.get_prism_workspace()?;
    let mut groups = read_groups(&prism_dir)?;

    let before = groups.groups.len();
    groups.groups.retain(|g| g.name != name);
    if groups.groups.len() == before {
        return Err(format!("Group '{name}' not found"));
    }

    write_groups(&prism_dir, &groups)
}

#[tauri::command]
pub fn rule_group_move(
    state: State<PrismState>,
    filename: String,
    target_group: Option<String>,
) -> Result<(), String> {
    let prism_dir = state.get_prism_workspace()?;
    let safe = sanitize_filename(&filename)?;
    let mut groups = read_groups(&prism_dir)?;

    // Remove file from all groups first
    for group in &mut groups.groups {
        group.files.retain(|f| f != &safe);
    }

    // If a target group is specified, add the file to it
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

    write_groups(&prism_dir, &groups)
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
