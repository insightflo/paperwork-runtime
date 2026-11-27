//! Paperwork native Rust bot & terminal runtime.
//!
//! Provides:
//! - [`governance`]: Fail-closed multi-company bot, data-scope, terminal, and channel policy evaluation.
//! - [`token`]: Constant-time SHA-256 token verification and secret redaction.
//! - [`client`]: Lightweight stdlib HTTP client, compatibility handshake, and jittered heartbeat daemon.
//! - [`control_sock`]: Local UDS control plane for the Paperwork bot heartbeat daemon (`status`, `drain`, `shutdown`).
//! - [`state`]: Atomic `0600` `state.json` persistence (never stores raw tokens).
//! - [`executor`]: Confined `-pgid` command execution with isolated env scrubbing and streaming redaction.
//! - [`service_install`]: Personal endpoint config validation/writing and OS service-unit renderers.
//! - [`local_tools`]: Fail-closed local file/shell/CLI primitives and local CLI auto-discovery.

// Preserve crate-qualified imports in endpoint modules also included by standalone tests.
extern crate self as paperwork_bot_runtime;

pub mod client;
#[cfg(unix)]
pub mod control_sock;
pub mod endpoint_audit;
pub mod endpoint_daemon;
pub mod endpoint_dispatch;
pub mod endpoint_doctor;
pub mod endpoint_pairing;
pub mod endpoint_protocol;
pub mod endpoint_sync;
#[cfg(unix)]
pub mod executor;
pub mod governance;
pub mod local_tools;
pub mod service_install;
pub mod state;
pub mod token;

pub use governance::{
    evaluate_bot_dispatch, evaluate_capability_data_scope, evaluate_channel_invoke,
    evaluate_policy, evaluate_terminal_command, evaluate_terminal_registration, ActorContext,
    ActorRole, BotActorContext, BotDescriptor, BotDispatchRequest, BotKind, BotStatus, CallableBy,
    CapabilityDataScopeRequest, ChannelExecutionTarget, ChannelInvokeRequest, DataScope,
    DecisionEffect, GovernanceDecision, PolicyEvalRequest, TerminalAction, TerminalCommandRequest,
    TerminalKind, TerminalRegistrationRequest,
};
pub use state::{load_state, save_state_atomic, PersistedDaemonState, StateError};
pub use token::{
    constant_time_eq, redact_json_value, redact_secrets, sha256_hex, validate_token_prefix,
    verify_token_sha256, TokenKind,
};
