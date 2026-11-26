//! Paperwork native Rust bot & terminal runtime.
//!
//! Provides:
//! - [`governance`]: Fail-closed multi-company bot, data-scope, terminal, and channel policy evaluation.
//! - [`token`]: Constant-time SHA-256 token verification and secret redaction.
//! - [`client`]: Lightweight stdlib HTTP client and heartbeat daemon helpers for the Paperwork control plane.

pub mod client;
pub mod governance;
pub mod token;

pub use governance::{
    evaluate_bot_dispatch, evaluate_capability_data_scope, evaluate_channel_invoke,
    evaluate_policy, evaluate_terminal_command, evaluate_terminal_registration, ActorContext,
    ActorRole, BotDescriptor, BotDispatchRequest, BotKind, BotStatus, CallableBy,
    CapabilityDataScopeRequest, ChannelInvokeRequest, DataScope, DecisionEffect,
    GovernanceDecision, PolicyEvalRequest, TerminalCommandRequest, TerminalRegistrationRequest,
};
pub use token::{
    constant_time_eq, redact_json_value, redact_secrets, sha256_hex, validate_token_prefix,
    verify_token_sha256, TokenKind,
};
