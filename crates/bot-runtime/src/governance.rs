//! Fail-closed governance evaluator for Paperwork multi-company bots, terminals, and channel relays.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BotKind {
    Personal,
    Team,
    Company,
}

impl BotKind {
    fn scope_rank(self) -> u8 {
        match self {
            BotKind::Personal => 0,
            BotKind::Team => 1,
            BotKind::Company => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallableBy {
    #[serde(alias = "self")]
    SelfOnly,
    Team,
    Company,
}

impl CallableBy {
    fn scope_rank(self) -> u8 {
        match self {
            CallableBy::SelfOnly => 0,
            CallableBy::Team => 1,
            CallableBy::Company => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataScope {
    #[serde(alias = "self")]
    SelfScope,
    Team,
    Company,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorRole {
    Owner,
    Admin,
    Member,
    Viewer,
}

impl ActorRole {
    pub fn is_privileged(self) -> bool {
        matches!(self, ActorRole::Owner | ActorRole::Admin)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BotStatus {
    Active,
    Paused,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionEffect {
    Allow,
    Deny,
    RequireApproval,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GovernanceDecision {
    pub allowed: bool,
    pub requires_approval: bool,
    pub effect: DecisionEffect,
    pub reason_code: String,
    pub message: String,
}

impl GovernanceDecision {
    pub fn allow(reason_code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            allowed: true,
            requires_approval: false,
            effect: DecisionEffect::Allow,
            reason_code: reason_code.into(),
            message: message.into(),
        }
    }

    pub fn deny(reason_code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            allowed: false,
            requires_approval: false,
            effect: DecisionEffect::Deny,
            reason_code: reason_code.into(),
            message: message.into(),
        }
    }

    pub fn require_approval(reason_code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            allowed: false,
            requires_approval: true,
            effect: DecisionEffect::RequireApproval,
            reason_code: reason_code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActorContext {
    pub company_id: String,
    pub user_id: String,
    #[serde(default)]
    pub team_id: Option<String>,
    pub role: ActorRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotDescriptor {
    pub bot_id: String,
    pub company_id: String,
    pub owner_user_id: String,
    #[serde(default)]
    pub team_id: Option<String>,
    pub kind: BotKind,
    pub callable_by: CallableBy,
    pub data_scope: DataScope,
    pub status: BotStatus,
    #[serde(default)]
    pub requires_approval: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotDispatchRequest {
    pub actor: ActorContext,
    pub bot: BotDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityDataScopeRequest {
    pub actor: ActorContext,
    pub bot: BotDescriptor,
    pub requested_scope: DataScope,
    pub target_company_id: String,
    #[serde(default)]
    pub target_team_id: Option<String>,
    #[serde(default)]
    pub target_user_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalRegistrationRequest {
    pub actor: ActorContext,
    pub target_company_id: String,
    #[serde(default)]
    pub target_team_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCommandRequest {
    pub actor: ActorContext,
    pub terminal_company_id: String,
    pub terminal_owner_user_id: String,
    #[serde(default)]
    pub terminal_team_id: Option<String>,
    pub terminal_active: bool,
    pub command: String,
    #[serde(default)]
    pub requires_approval: bool,
    #[serde(default)]
    pub dangerous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelInvokeRequest {
    pub actor: ActorContext,
    pub bot: BotDescriptor,
    pub channel_company_id: String,
    #[serde(default)]
    pub channel_team_id: Option<String>,
    #[serde(default)]
    pub requires_approval: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum PolicyEvalRequest {
    BotDispatch(BotDispatchRequest),
    CapabilityDataScope(CapabilityDataScopeRequest),
    TerminalRegistration(TerminalRegistrationRequest),
    TerminalCommand(TerminalCommandRequest),
    ChannelInvoke(ChannelInvokeRequest),
}

fn is_blank(s: &str) -> bool {
    s.trim().is_empty()
}

fn validate_actor(actor: &ActorContext) -> Result<(), GovernanceDecision> {
    if is_blank(&actor.company_id) || is_blank(&actor.user_id) {
        return Err(GovernanceDecision::deny(
            "invalid_actor_context",
            "actor company_id and user_id must be non-empty",
        ));
    }
    Ok(())
}

fn validate_bot(bot: &BotDescriptor) -> Result<(), GovernanceDecision> {
    if is_blank(&bot.bot_id) || is_blank(&bot.company_id) || is_blank(&bot.owner_user_id) {
        return Err(GovernanceDecision::deny(
            "invalid_bot_descriptor",
            "bot_id, company_id, and owner_user_id must be non-empty",
        ));
    }
    Ok(())
}

/// Core fail-closed eligibility check shared by dispatch, capability scope, and channel invoke.
fn check_bot_base_access(actor: &ActorContext, bot: &BotDescriptor) -> Result<(), GovernanceDecision> {
    validate_actor(actor)?;
    validate_bot(bot)?;

    if actor.company_id != bot.company_id {
        return Err(GovernanceDecision::deny(
            "company_mismatch",
            "actor and bot belong to different companies",
        ));
    }

    match bot.status {
        BotStatus::Revoked => {
            return Err(GovernanceDecision::deny(
                "bot_revoked",
                "revoked bots cannot be dispatched",
            ));
        }
        BotStatus::Paused => {
            return Err(GovernanceDecision::deny(
                "bot_paused",
                "paused bots cannot be dispatched",
            ));
        }
        BotStatus::Active => {}
    }

    if actor.role == ActorRole::Viewer {
        return Err(GovernanceDecision::deny(
            "viewer_forbidden",
            "viewer role is not permitted to invoke bots",
        ));
    }

    // Fail-closed effective reachability: bounded by the stricter of `bot.kind` and `bot.callable_by`.
    let effective_rank = bot.kind.scope_rank().min(bot.callable_by.scope_rank());

    match effective_rank {
        0 => {
            // Self-only / Personal bot: only the owning user may invoke it.
            if actor.user_id != bot.owner_user_id {
                return Err(GovernanceDecision::deny(
                    "not_bot_owner",
                    "personal or self-only bots can only be invoked by their owner",
                ));
            }
        }
        1 => {
            // Team-scoped bot: owner, privileged company admin/owner, or matching team member.
            let same_team = bot
                .team_id
                .as_deref()
                .filter(|t| !is_blank(t))
                .zip(actor.team_id.as_deref().filter(|t| !is_blank(t)))
                .is_some_and(|(bt, at)| bt == at);

            if actor.user_id != bot.owner_user_id && !actor.role.is_privileged() && !same_team {
                return Err(GovernanceDecision::deny(
                    "team_mismatch",
                    "actor is not a member of the bot's team",
                ));
            }
        }
        2 => {
            // Company-scoped bot: any non-viewer member of the same company (already checked).
        }
        _ => {
            return Err(GovernanceDecision::deny(
                "invalid_scope_rank",
                "unrecognized bot scope configuration",
            ));
        }
    }

    Ok(())
}

/// Evaluates whether `actor` may dispatch `bot`.
pub fn evaluate_bot_dispatch(req: &BotDispatchRequest) -> GovernanceDecision {
    if let Err(denial) = check_bot_base_access(&req.actor, &req.bot) {
        return denial;
    }

    if req.bot.requires_approval {
        return GovernanceDecision::require_approval(
            "bot_approval_required",
            "bot requires explicit approval before dispatch",
        );
    }

    GovernanceDecision::allow("ok", "bot dispatch allowed")
}

/// Evaluates whether `bot` dispatched by `actor` may access data at `requested_scope`.
pub fn evaluate_capability_data_scope(req: &CapabilityDataScopeRequest) -> GovernanceDecision {
    if let Err(denial) = check_bot_base_access(&req.actor, &req.bot) {
        return denial;
    }

    if is_blank(&req.target_company_id) || req.target_company_id != req.bot.company_id {
        return GovernanceDecision::deny(
            "cross_company_data_denied",
            "cross-company data access is forbidden",
        );
    }

    if req.requested_scope > req.bot.data_scope {
        return GovernanceDecision::deny(
            "data_scope_exceeded",
            "requested data scope exceeds the bot's configured data_scope",
        );
    }

    match req.requested_scope {
        DataScope::SelfScope => {
            if let Some(target_user) = req.target_user_id.as_deref().filter(|u| !is_blank(u)) {
                if target_user != req.bot.owner_user_id && target_user != req.actor.user_id {
                    return GovernanceDecision::deny(
                        "self_scope_user_mismatch",
                        "self data scope cannot read another user's private data",
                    );
                }
            }
        }
        DataScope::Team => {
            let Some(bot_team) = req.bot.team_id.as_deref().filter(|t| !is_blank(t)) else {
                return GovernanceDecision::deny(
                    "missing_bot_team",
                    "team data scope requires a non-empty bot team_id",
                );
            };
            if let Some(target_team) = req.target_team_id.as_deref().filter(|t| !is_blank(t)) {
                if target_team != bot_team {
                    return GovernanceDecision::deny(
                        "team_scope_mismatch",
                        "requested team data does not match the bot's team",
                    );
                }
            }
        }
        DataScope::Company => {
            // Same company and bot.data_scope == Company already verified.
        }
    }

    GovernanceDecision::allow("data_scope_allowed", "capability data scope allowed")
}

/// Evaluates whether `actor` may register a new terminal under `target_company_id`.
/// Always blocks `Viewer` role and cross-company registrations.
pub fn evaluate_terminal_registration(req: &TerminalRegistrationRequest) -> GovernanceDecision {
    if let Err(denial) = validate_actor(&req.actor) {
        return denial;
    }
    if is_blank(&req.target_company_id) {
        return GovernanceDecision::deny(
            "invalid_target_company",
            "target_company_id must be non-empty",
        );
    }
    if req.actor.company_id != req.target_company_id {
        return GovernanceDecision::deny(
            "company_mismatch",
            "cannot register a terminal in another company",
        );
    }
    if req.actor.role == ActorRole::Viewer {
        return GovernanceDecision::deny(
            "viewer_cannot_register_terminal",
            "viewer role is blocked from registering terminals",
        );
    }
    if let Some(target_team) = req.target_team_id.as_deref().filter(|t| !is_blank(t)) {
        if !req.actor.role.is_privileged() && req.actor.team_id.as_deref() != Some(target_team) {
            return GovernanceDecision::deny(
                "team_mismatch",
                "member can only register a terminal for their own team",
            );
        }
    }

    GovernanceDecision::allow(
        "terminal_registration_allowed",
        "terminal registration allowed",
    )
}

/// Evaluates whether `actor` may execute a command on a registered terminal.
pub fn evaluate_terminal_command(req: &TerminalCommandRequest) -> GovernanceDecision {
    if let Err(denial) = validate_actor(&req.actor) {
        return denial;
    }
    if is_blank(&req.terminal_company_id) || is_blank(&req.terminal_owner_user_id) {
        return GovernanceDecision::deny(
            "invalid_terminal_context",
            "terminal company_id and owner_user_id must be non-empty",
        );
    }
    if is_blank(&req.command) {
        return GovernanceDecision::deny("empty_command", "terminal command must be non-empty");
    }
    if req.actor.company_id != req.terminal_company_id {
        return GovernanceDecision::deny(
            "company_mismatch",
            "actor and terminal belong to different companies",
        );
    }
    if !req.terminal_active {
        return GovernanceDecision::deny(
            "terminal_inactive",
            "cannot execute commands on an inactive or revoked terminal",
        );
    }
    if req.actor.role == ActorRole::Viewer {
        return GovernanceDecision::deny(
            "viewer_forbidden",
            "viewer role cannot execute terminal commands",
        );
    }

    let same_team = req
        .terminal_team_id
        .as_deref()
        .filter(|t| !is_blank(t))
        .zip(req.actor.team_id.as_deref().filter(|t| !is_blank(t)))
        .is_some_and(|(tt, at)| tt == at);

    let authorized = req.actor.role.is_privileged()
        || req.actor.user_id == req.terminal_owner_user_id
        || same_team;

    if !authorized {
        return GovernanceDecision::deny(
            "terminal_access_denied",
            "actor does not own or share a team with this terminal",
        );
    }

    if req.dangerous || req.requires_approval {
        return GovernanceDecision::require_approval(
            "terminal_command_approval_required",
            "terminal command requires approval before execution",
        );
    }

    GovernanceDecision::allow("terminal_command_allowed", "terminal command allowed")
}

/// Evaluates channel-originated bot invocations.
/// Requires approval when cross-team, company-wide, or explicitly flagged `requires_approval`.
pub fn evaluate_channel_invoke(req: &ChannelInvokeRequest) -> GovernanceDecision {
    if is_blank(&req.channel_company_id) {
        return GovernanceDecision::deny(
            "invalid_channel_context",
            "channel_company_id must be non-empty",
        );
    }
    if req.channel_company_id != req.actor.company_id
        || req.channel_company_id != req.bot.company_id
    {
        return GovernanceDecision::deny(
            "company_mismatch",
            "channel, actor, and bot must belong to the same company",
        );
    }

    if let Err(denial) = check_bot_base_access(&req.actor, &req.bot) {
        return denial;
    }

    if req.requires_approval || req.bot.requires_approval {
        return GovernanceDecision::require_approval(
            "channel_approval_required",
            "channel invocation explicitly requires approval",
        );
    }

    if req.bot.kind == BotKind::Company || req.bot.callable_by == CallableBy::Company {
        return GovernanceDecision::require_approval(
            "company_channel_approval_required",
            "company-scoped channel invocations require approval",
        );
    }

    let channel_team = req.channel_team_id.as_deref().filter(|t| !is_blank(t));
    let actor_team = req.actor.team_id.as_deref().filter(|t| !is_blank(t));
    let bot_team = req.bot.team_id.as_deref().filter(|t| !is_blank(t));

    match channel_team {
        None => GovernanceDecision::require_approval(
            "company_channel_approval_required",
            "company-wide channel invocation requires approval",
        ),
        Some(ct) => {
            let cross_team = actor_team != Some(ct) || bot_team.is_some_and(|bt| bt != ct);
            if cross_team {
                GovernanceDecision::require_approval(
                    "cross_team_approval_required",
                    "cross-team channel invocation requires approval",
                )
            } else {
                GovernanceDecision::allow("channel_invoke_allowed", "channel invocation allowed")
            }
        }
    }
}

/// Unified entry point for CLI / JSON policy evaluation.
pub fn evaluate_policy(req: &PolicyEvalRequest) -> GovernanceDecision {
    match req {
        PolicyEvalRequest::BotDispatch(r) => evaluate_bot_dispatch(r),
        PolicyEvalRequest::CapabilityDataScope(r) => evaluate_capability_data_scope(r),
        PolicyEvalRequest::TerminalRegistration(r) => evaluate_terminal_registration(r),
        PolicyEvalRequest::TerminalCommand(r) => evaluate_terminal_command(r),
        PolicyEvalRequest::ChannelInvoke(r) => evaluate_channel_invoke(r),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(role: ActorRole, user_id: &str, team_id: Option<&str>) -> ActorContext {
        ActorContext {
            company_id: "co-1".into(),
            user_id: user_id.into(),
            team_id: team_id.map(str::to_string),
            role,
        }
    }

    fn bot(
        kind: BotKind,
        callable_by: CallableBy,
        data_scope: DataScope,
        status: BotStatus,
    ) -> BotDescriptor {
        BotDescriptor {
            bot_id: "bot-1".into(),
            company_id: "co-1".into(),
            owner_user_id: "u-owner".into(),
            team_id: Some("team-a".into()),
            kind,
            callable_by,
            data_scope,
            status,
            requires_approval: false,
        }
    }

    #[test]
    fn dispatch_personal_bot_allows_owner_denies_others_even_admin() {
        let b = bot(
            BotKind::Personal,
            CallableBy::SelfOnly,
            DataScope::SelfScope,
            BotStatus::Active,
        );
        let ok = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Member, "u-owner", Some("team-a")),
            bot: b.clone(),
        });
        assert!(ok.allowed);
        assert_eq!(ok.effect, DecisionEffect::Allow);

        let denied = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Admin, "u-admin", Some("team-a")),
            bot: b,
        });
        assert!(!denied.allowed);
        assert_eq!(denied.reason_code, "not_bot_owner");
    }

    #[test]
    fn dispatch_team_bot_allows_same_team_and_admin_denies_other_team() {
        let b = bot(
            BotKind::Team,
            CallableBy::Team,
            DataScope::Team,
            BotStatus::Active,
        );
        let same_team = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Member, "u-2", Some("team-a")),
            bot: b.clone(),
        });
        assert!(same_team.allowed);

        let admin = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Admin, "u-admin", Some("team-b")),
            bot: b.clone(),
        });
        assert!(admin.allowed);

        let other_team = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Member, "u-3", Some("team-b")),
            bot: b,
        });
        assert!(!other_team.allowed);
        assert_eq!(other_team.reason_code, "team_mismatch");
    }

    #[test]
    fn dispatch_company_bot_allows_member_denies_viewer_and_cross_company() {
        let b = bot(
            BotKind::Company,
            CallableBy::Company,
            DataScope::Company,
            BotStatus::Active,
        );
        let member = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Member, "u-9", Some("team-z")),
            bot: b.clone(),
        });
        assert!(member.allowed);

        let viewer = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Viewer, "u-view", Some("team-a")),
            bot: b.clone(),
        });
        assert!(!viewer.allowed);
        assert_eq!(viewer.reason_code, "viewer_forbidden");

        let mut other_co = actor(ActorRole::Owner, "u-owner", Some("team-a"));
        other_co.company_id = "co-2".into();
        let cross = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: other_co,
            bot: b,
        });
        assert!(!cross.allowed);
        assert_eq!(cross.reason_code, "company_mismatch");
    }

    #[test]
    fn dispatch_rejects_revoked_and_paused_bots() {
        let revoked = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Owner, "u-owner", Some("team-a")),
            bot: bot(
                BotKind::Company,
                CallableBy::Company,
                DataScope::Company,
                BotStatus::Revoked,
            ),
        });
        assert!(!revoked.allowed);
        assert_eq!(revoked.reason_code, "bot_revoked");

        let paused = evaluate_bot_dispatch(&BotDispatchRequest {
            actor: actor(ActorRole::Owner, "u-owner", Some("team-a")),
            bot: bot(
                BotKind::Company,
                CallableBy::Company,
                DataScope::Company,
                BotStatus::Paused,
            ),
        });
        assert!(!paused.allowed);
        assert_eq!(paused.reason_code, "bot_paused");
    }

    #[test]
    fn capability_data_scope_enforces_ceiling_and_isolation() {
        let b = bot(
            BotKind::Team,
            CallableBy::Team,
            DataScope::Team,
            BotStatus::Active,
        );
        let exceeded = evaluate_capability_data_scope(&CapabilityDataScopeRequest {
            actor: actor(ActorRole::Member, "u-2", Some("team-a")),
            bot: b.clone(),
            requested_scope: DataScope::Company,
            target_company_id: "co-1".into(),
            target_team_id: None,
            target_user_id: None,
        });
        assert!(!exceeded.allowed);
        assert_eq!(exceeded.reason_code, "data_scope_exceeded");

        let wrong_team = evaluate_capability_data_scope(&CapabilityDataScopeRequest {
            actor: actor(ActorRole::Member, "u-2", Some("team-a")),
            bot: b.clone(),
            requested_scope: DataScope::Team,
            target_company_id: "co-1".into(),
            target_team_id: Some("team-b".into()),
            target_user_id: None,
        });
        assert!(!wrong_team.allowed);
        assert_eq!(wrong_team.reason_code, "team_scope_mismatch");

        let ok = evaluate_capability_data_scope(&CapabilityDataScopeRequest {
            actor: actor(ActorRole::Member, "u-2", Some("team-a")),
            bot: b,
            requested_scope: DataScope::Team,
            target_company_id: "co-1".into(),
            target_team_id: Some("team-a".into()),
            target_user_id: None,
        });
        assert!(ok.allowed);
    }

    #[test]
    fn terminal_registration_blocks_viewer_and_allows_member_same_team() {
        let viewer = evaluate_terminal_registration(&TerminalRegistrationRequest {
            actor: actor(ActorRole::Viewer, "u-v", Some("team-a")),
            target_company_id: "co-1".into(),
            target_team_id: Some("team-a".into()),
        });
        assert!(!viewer.allowed);
        assert_eq!(viewer.reason_code, "viewer_cannot_register_terminal");

        let member_ok = evaluate_terminal_registration(&TerminalRegistrationRequest {
            actor: actor(ActorRole::Member, "u-m", Some("team-a")),
            target_company_id: "co-1".into(),
            target_team_id: Some("team-a".into()),
        });
        assert!(member_ok.allowed);

        let member_wrong_team = evaluate_terminal_registration(&TerminalRegistrationRequest {
            actor: actor(ActorRole::Member, "u-m", Some("team-a")),
            target_company_id: "co-1".into(),
            target_team_id: Some("team-b".into()),
        });
        assert!(!member_wrong_team.allowed);
        assert_eq!(member_wrong_team.reason_code, "team_mismatch");
    }

    #[test]
    fn terminal_command_enforces_active_role_and_approval_gate() {
        let inactive = evaluate_terminal_command(&TerminalCommandRequest {
            actor: actor(ActorRole::Owner, "u-owner", Some("team-a")),
            terminal_company_id: "co-1".into(),
            terminal_owner_user_id: "u-owner".into(),
            terminal_team_id: Some("team-a".into()),
            terminal_active: false,
            command: "status".into(),
            requires_approval: false,
            dangerous: false,
        });
        assert!(!inactive.allowed);
        assert_eq!(inactive.reason_code, "terminal_inactive");

        let approval = evaluate_terminal_command(&TerminalCommandRequest {
            actor: actor(ActorRole::Member, "u-owner", Some("team-a")),
            terminal_company_id: "co-1".into(),
            terminal_owner_user_id: "u-owner".into(),
            terminal_team_id: Some("team-a".into()),
            terminal_active: true,
            command: "deploy --prod".into(),
            requires_approval: false,
            dangerous: true,
        });
        assert!(!approval.allowed);
        assert!(approval.requires_approval);
        assert_eq!(approval.effect, DecisionEffect::RequireApproval);
    }

    #[test]
    fn channel_invoke_requires_approval_for_cross_team_company_or_explicit_flag() {
        let team_bot = bot(
            BotKind::Team,
            CallableBy::Team,
            DataScope::Team,
            BotStatus::Active,
        );
        // Same team -> allowed
        let ok = evaluate_channel_invoke(&ChannelInvokeRequest {
            actor: actor(ActorRole::Member, "u-2", Some("team-a")),
            bot: team_bot.clone(),
            channel_company_id: "co-1".into(),
            channel_team_id: Some("team-a".into()),
            requires_approval: false,
        });
        assert!(ok.allowed);
        assert!(!ok.requires_approval);

        // Cross-team channel (admin invoking team-a bot in team-b channel) -> require approval
        let cross_team = evaluate_channel_invoke(&ChannelInvokeRequest {
            actor: actor(ActorRole::Admin, "u-admin", Some("team-b")),
            bot: team_bot.clone(),
            channel_company_id: "co-1".into(),
            channel_team_id: Some("team-b".into()),
            requires_approval: false,
        });
        assert!(!cross_team.allowed);
        assert!(cross_team.requires_approval);
        assert_eq!(cross_team.reason_code, "cross_team_approval_required");

        // Company-scoped bot in channel -> require approval
        let company_bot = bot(
            BotKind::Company,
            CallableBy::Company,
            DataScope::Company,
            BotStatus::Active,
        );
        let company_ch = evaluate_channel_invoke(&ChannelInvokeRequest {
            actor: actor(ActorRole::Member, "u-2", Some("team-a")),
            bot: company_bot,
            channel_company_id: "co-1".into(),
            channel_team_id: Some("team-a".into()),
            requires_approval: false,
        });
        assert!(!company_ch.allowed);
        assert!(company_ch.requires_approval);
        assert_eq!(company_ch.reason_code, "company_channel_approval_required");

        // Explicit requires_approval flag -> require approval
        let explicit = evaluate_channel_invoke(&ChannelInvokeRequest {
            actor: actor(ActorRole::Member, "u-2", Some("team-a")),
            bot: team_bot,
            channel_company_id: "co-1".into(),
            channel_team_id: Some("team-a".into()),
            requires_approval: true,
        });
        assert!(!explicit.allowed);
        assert!(explicit.requires_approval);
        assert_eq!(explicit.reason_code, "channel_approval_required");
    }

    #[test]
    fn policy_eval_request_json_roundtrip() {
        let req = PolicyEvalRequest::ChannelInvoke(ChannelInvokeRequest {
            actor: actor(ActorRole::Member, "u-2", Some("team-a")),
            bot: bot(
                BotKind::Team,
                CallableBy::Team,
                DataScope::Team,
                BotStatus::Active,
            ),
            channel_company_id: "co-1".into(),
            channel_team_id: Some("team-a".into()),
            requires_approval: true,
        });
        let raw = serde_json::to_string(&req).unwrap();
        let parsed: PolicyEvalRequest = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, req);
        let decision = evaluate_policy(&parsed);
        let decision_json = serde_json::to_string(&decision).unwrap();
        let decision_back: GovernanceDecision = serde_json::from_str(&decision_json).unwrap();
        assert_eq!(decision_back, decision);
        assert!(decision_back.requires_approval);
    }
}
