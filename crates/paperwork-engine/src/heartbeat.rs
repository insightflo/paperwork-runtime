//! heartbeat.* JSON-RPC methods: direct-PG wakeup claim, fenced run-status
//! transitions, and stale-run listing over cancellable tokio-postgres on a
//! shared current_thread runtime (single block_on serializer). One `Instant`
//! deadline covers dial, handshake, and queries. Fail-closed commit contract:
//! any timeout before `tx.commit()` => -32001 not_committed/retryable; once
//! commit() is invoked a confirmed Ok wins deadline races and ANY non-Ok =>
//! -32005 indeterminate/never-retry.
use chrono::{DateTime, Utc};
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_heartbeat::{clamp_stale_limit, validate_transition, HeartbeatDbError, RunStatus, SQL_CLAIM_WAKEUP, SQL_LIST_STALE_RUNS, SQL_SELECT_QUEUED_WAKEUP, SQL_TRANSITION_RUN_FENCED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{future::Future, io, net::{IpAddr, SocketAddr, ToSocketAddrs}, pin::Pin, str::FromStr, sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tokio::net::{TcpSocket, TcpStream};
use tokio_postgres::{config::{ChannelBinding, Host, LoadBalanceHosts, SslMode, SslNegotiation, TargetSessionAttrs}, Client, Config, NoTls, Row, Transaction};
use uuid::Uuid;

const MAX_INFLIGHT_DNS: usize = 2;
const COMMIT_ACK_CAP: Duration = Duration::from_secs(10);
static INFLIGHT_DNS: AtomicUsize = AtomicUsize::new(0);
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static CALL_LOCK: Mutex<()> = Mutex::new(());
#[derive(Debug, PartialEq)] pub(crate) struct Fail(pub(crate) i64, pub(crate) &'static str, pub(crate) &'static str, pub(crate) bool); // code, message, outcome, retryable
const T_OUT: Fail = Fail(-32001, "db_timeout", "not_committed", true); const UNCONF: Fail = Fail(-32002, "db_unconfigured", "not_committed", false);
const BUSY: Fail = Fail(-32003, "db_busy", "not_committed", true); pub(crate) const DBERR: Fail = Fail(-32004, "db_error", "not_committed", false); const INDET: Fail = Fail(-32005, "db_commit_indeterminate", "indeterminate", false);
pub(crate) fn ok(id: Value, result: Value) -> Value { json!({"jsonrpc":"2.0","id":id,"result":result}) }
pub(crate) fn err(id: Value, code: i64, message: &str) -> Value { json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}) }
fn fail(id: Value, f: Fail) -> Value { json!({"jsonrpc":"2.0","id":id,"error":{"code":f.0,"message":f.1,"data":{"outcome":f.2,"retryable":f.3}}}) }
fn rem(dl: Instant) -> Duration { dl.saturating_duration_since(Instant::now()) }
pub(crate) fn pre(e: tokio_postgres::Error) -> Fail { if e.as_db_error().is_some_and(|d| matches!(d.code().code(), "57014" | "55P03")) { T_OUT } else { DBERR } }

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ValidateP { expected_statuses: Vec<RunStatus>, next_status: RunStatus }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ClaimP { company_id: Uuid, agent_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct TransitionP { run_id: Uuid, company_id: Uuid, expected_statuses: Vec<RunStatus>, next_status: RunStatus, #[serde(default)] error: Option<String>, #[serde(default)] error_code: Option<String> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct StaleP { company_id: Uuid, stale_before: DateTime<Utc>, limit: i64 }
enum Db { Claim(ClaimP), Transition(TransitionP), Stale(StaleP) } impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

/// Exhaustive apply-or-reject DSN contract: plaintext loopback-only single
/// host, keepalives on, no option outside the applied set -> -32002 pre-dial.
fn checked_config(env: &ProbeEnv) -> Result<(Config, String, u16), Fail> {
    let mut c = Config::from_str(env.get("DATABASE_URL").ok_or(UNCONF)?).map_err(|_| UNCONF)?;
    let host = match c.get_hosts() { [Host::Tcp(h)] => h.clone(), _ => return Err(UNCONF) };
    let good = c.get_user().is_some_and(|u| !u.is_empty()) && c.get_ports().len() <= 1
        && c.get_hostaddrs().is_empty() && c.get_ssl_mode() == SslMode::Disable && c.get_ssl_negotiation() == SslNegotiation::Postgres
        && c.get_tcp_user_timeout().is_none() && c.get_target_session_attrs() == TargetSessionAttrs::Any && c.get_channel_binding() != ChannelBinding::Require
        && c.get_load_balance_hosts() == LoadBalanceHosts::Disable && c.get_keepalives() && c.get_keepalives_idle() == Config::new().get_keepalives_idle()
        && c.get_keepalives_interval().is_none() && c.get_keepalives_retries().is_none() && c.get_options().is_none();
    if !good { return Err(UNCONF) }
    c.options("-c statement_timeout=5000 -c lock_timeout=3000");
    let port = c.get_ports().first().copied().unwrap_or(5432);
    Ok((c, host, port))
}

struct Permit; // RAII guard held inside the spawn_blocking task until DNS returns
impl Drop for Permit { fn drop(&mut self) { INFLIGHT_DNS.fetch_sub(1, Ordering::SeqCst); } }
fn dns_permit() -> Option<Permit> { let mut n = INFLIGHT_DNS.load(Ordering::SeqCst); while n < MAX_INFLIGHT_DNS { match INFLIGHT_DNS.compare_exchange_weak(n, n + 1, Ordering::SeqCst, Ordering::SeqCst) { Ok(_) => return Some(Permit), Err(x) => n = x } } None }

type IoFut = Pin<Box<dyn Future<Output = io::Result<TcpStream>> + Send>>;
type ResolveFn = Arc<dyn Fn(&str, u16) -> io::Result<Vec<SocketAddr>> + Send + Sync>;
type ApplyFn = Arc<dyn Fn(&TcpSocket, &Config) -> io::Result<()> + Send + Sync>; type DialFn = Arc<dyn Fn(TcpSocket, SocketAddr, Duration) -> IoFut + Send + Sync>;
#[derive(Clone)]
struct Hooks { resolve: ResolveFn, apply: ApplyFn, dial: DialFn }
fn hooks() -> &'static Hooks {
    static H: OnceLock<Hooks> = OnceLock::new();
    H.get_or_init(|| Hooks {
        resolve: Arc::new(|h, p| (h, p).to_socket_addrs().map(|i| i.collect())),
        apply: Arc::new(|s, c| {
            let r = socket2::SockRef::from(s);
            r.set_keepalive(c.get_keepalives())?;
            let mut k = socket2::TcpKeepalive::new().with_time(c.get_keepalives_idle());
            if let Some(v) = c.get_keepalives_interval() { k = k.with_interval(v); }
            #[cfg(any(target_os = "android", target_os = "dragonfly", target_os = "emscripten", target_os = "freebsd", target_os = "fuchsia", target_os = "illumos", target_os = "ios", target_os = "visionos", target_os = "linux", target_os = "macos", target_os = "netbsd", target_os = "tvos", target_os = "watchos", target_os = "cygwin", target_os = "windows", all(target_os = "wasi", not(target_env = "p1"))))]
            if let Some(v) = c.get_keepalives_retries() { k = k.with_retries(v); }
            r.set_tcp_keepalive(&k)
        }),
        dial: Arc::new(|s, a, t| Box::pin(async move { tokio::time::timeout(t, s.connect(a)).await.unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "dial"))) })),
    })
}

/// Loopback-only dial: IP literals skip DNS and share the exact same
/// TcpSocket -> apply -> connect path as DNS-resolved addresses. Hostname
/// lookups take one of MAX_INFLIGHT_DNS permits inside spawn_blocking (cap
/// hit => -32003, no lookup spawned). Option-apply failure => -32002 pre-dial.
async fn connect_checked(c: &Config, host: &str, port: u16, h: &Hooks, dl: Instant) -> Result<TcpStream, Fail> {
    let addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => {
            let Some(p) = dns_permit() else { return Err(BUSY) };
            let (host, resolve) = (host.to_owned(), h.resolve.clone());
            let j = tokio::task::spawn_blocking(move || { let _p = p; resolve(&host, port) });
            match tokio::time::timeout(rem(dl), j).await { Ok(Ok(Ok(a))) => a, Err(_) => return Err(T_OUT), _ => return Err(DBERR) }
        }
    };
    if addrs.is_empty() || !addrs.iter().all(|a| a.ip().is_loopback()) { return Err(UNCONF) }
    for a in addrs {
        let s = if a.is_ipv4() { TcpSocket::new_v4() } else { TcpSocket::new_v6() }.map_err(|_| DBERR)?;
        (h.apply)(&s, c).map_err(|_| UNCONF)?;
        let t = c.get_connect_timeout().copied().unwrap_or(Duration::from_secs(3)).min(rem(dl));
        match (h.dial)(s, a, t).await {
            Ok(s) => return Ok(s),
            Err(e) if e.kind() == io::ErrorKind::TimedOut => return Err(T_OUT),
            Err(_) => continue,
        }
    }
    Err(DBERR)
}

fn wake_json(r: &Row) -> Value { json!({"id": r.get::<_, Uuid>(0), "company_id": r.get::<_, Uuid>(1), "agent_id": r.get::<_, Uuid>(2), "source": r.get::<_, String>(3), "reason": r.get::<_, Option<String>>(4), "idempotency_key": r.get::<_, Option<String>>(5), "payload": r.get::<_, Option<Value>>(6), "requested_at": r.get::<_, DateTime<Utc>>(7), "claimed_at": r.get::<_, Option<DateTime<Utc>>>(8)}) }
fn stale_json(r: &Row) -> Value { json!({"id": r.get::<_, Uuid>(0), "company_id": r.get::<_, Uuid>(1), "agent_id": r.get::<_, Uuid>(2), "process_pid": r.get::<_, Option<i32>>(3), "process_loss_retry_count": r.get::<_, i32>(4), "updated_at": r.get::<_, DateTime<Utc>>(5)}) }

pub(crate) enum Step<'x> { Commit(Transaction<'x>, Value), Done(Value) }
pub(crate) type OpFut<'x> = Pin<Box<dyn Future<Output = Result<Step<'x>, Fail>> + 'x>>; pub(crate) trait DbOp { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x>; }
async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Claim(p) => {
            let sel = tx.query_opt(SQL_SELECT_QUEUED_WAKEUP, &[&p.company_id, &p.agent_id]).await.map_err(pre)?;
            let row = match sel { Some(s) => tx.query_opt(SQL_CLAIM_WAKEUP, &[&s.get::<_, Uuid>(0), &p.company_id]).await.map_err(pre)?, None => None };
            Step::Commit(tx, json!({"claimed": row.map_or(Value::Null, |r| wake_json(&r))}))
        }
        Db::Transition(p) => {
            let plan = validate_transition(&p.expected_statuses, p.next_status).map_err(|_| DBERR)?;
            let exp: Vec<&str> = p.expected_statuses.iter().map(|s| s.as_str()).collect();
            let row = tx.query_opt(SQL_TRANSITION_RUN_FENCED, &[&p.run_id, &p.next_status.as_str(), &plan.sets_started_at, &plan.sets_finished_at, &p.error, &p.error_code, &p.company_id, &exp]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"applied":true,"run_id":r.get::<_, Uuid>(0),"status":r.get::<_, String>(1),"started_at":r.get::<_, Option<DateTime<Utc>>>(2),"finished_at":r.get::<_, Option<DateTime<Utc>>>(3)}),
                None => json!({"applied": false}) })
        }
        Db::Stale(p) => {
            let rows = tx.query(SQL_LIST_STALE_RUNS, &[&p.company_id, &p.stale_before, &clamp_stale_limit(p.limit)]).await.map_err(pre)?;
            Step::Done(json!({"runs": rows.iter().map(stale_json).collect::<Vec<_>>()})) // read-only: tx dropped, never committed
        }
    })
}

async fn db_work(c: &mut Client, op: impl DbOp, dl: Instant) -> Result<Value, Fail> {
    let (tx, v) = match tokio::time::timeout(rem(dl), op.run(c)).await {
        Err(_) => return Err(T_OUT), Ok(Err(e)) => return Err(e),
        Ok(Ok(Step::Done(v))) => return Ok(v), Ok(Ok(Step::Commit(tx, v))) => (tx, v),
    };
    if Instant::now() >= dl { return Err(T_OUT) } // gate: drop tx without commit
    match tokio::time::timeout(COMMIT_ACK_CAP, tx.commit()).await { Ok(Ok(())) => Ok(v), _ => Err(INDET) }
}

/// Connect -> spawn driver -> op -> deadline-gated commit. The driver is
/// aborted and awaited inside the same block_on on every path after it is
/// spawned, so the socket is closed before the RPC returns.
async fn db_run(c: Config, host: String, port: u16, h: &Hooks, op: impl DbOp, dl: Instant) -> Result<Value, Fail> {
    let stream = connect_checked(&c, &host, port, h, dl).await?;
    let (mut client, conn) = match tokio::time::timeout(rem(dl), c.connect_raw(stream, NoTls)).await {
        Ok(Ok(v)) => v, Err(_) => return Err(T_OUT), Ok(Err(e)) => return Err(pre(e)) };
    let conn_handle = tokio::spawn(conn);
    let r = db_work(&mut client, op, dl).await;
    drop(client); conn_handle.abort(); let _ = conn_handle.await;
    r
}

/// Shared DB-backed RPC entry: checked DSN -> op -> deadline-gated commit.
pub(crate) fn exec_db(id: Value, env: &ProbeEnv, op_timeout: Duration, op: impl DbOp) -> Value {
    let (c, host, port) = match checked_config(env) { Ok(v) => v, Err(e) => return fail(id, e) };
    let rt = RUNTIME.get_or_init(|| tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(MAX_INFLIGHT_DNS).build().unwrap());
    let _g = CALL_LOCK.lock().unwrap();
    match rt.block_on(db_run(c, host, port, hooks(), op, Instant::now() + op_timeout)) { Ok(v) => ok(id, v), Err(e) => fail(id, e) }
}

fn validate_result(p: &ValidateP) -> Value {
    match validate_transition(&p.expected_statuses, p.next_status) {
        Ok(plan) => json!({"valid":true,"sets_started_at":plan.sets_started_at,"sets_finished_at":plan.sets_finished_at}),
        Err(HeartbeatDbError::IllegalTransition { from, to }) => json!({"valid":false,"reason":"illegal_transition","from":from.as_str(),"to":to.as_str()}),
        Err(_) => Value::Null,
    }
}

pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    dispatch_with_timeout(id, method, params, env, Duration::from_secs(6))
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). transition_run_fenced re-validates before any PG I/O.
pub(crate) fn dispatch_with_timeout(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv, op_timeout: Duration) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "heartbeat.validate_transition" => {
            let p = need!(ValidateP);
            if p.expected_statuses.is_empty() { return err(id, -32602, "invalid_params") }
            ok(id, validate_result(&p))
        }
        "heartbeat.claim_wakeup" => { let p = need!(ClaimP); exec_db(id, env, op_timeout, Db::Claim(p)) }
        "heartbeat.transition_run_fenced" => {
            let p = need!(TransitionP);
            if validate_transition(&p.expected_statuses, p.next_status).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, op_timeout, Db::Transition(p))
        }
        "heartbeat.list_stale_runs" => { let p = need!(StaleP); exec_db(id, env, op_timeout, Db::Stale(p)) }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use {super::*, std::{io::Read, sync::mpsc}};
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv, ms: u64) -> Value { dispatch_with_timeout(json!(1), m, Some(&p), e, Duration::from_millis(ms)) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) } fn cfg(u: &str) -> Config { Config::from_str(u).unwrap() }
    fn rt() -> tokio::runtime::Runtime { tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(MAX_INFLIGHT_DNS).build().unwrap() }

    #[test]
    fn param_gates_and_validate_matrix() {
        let (e, u, v) = (&env(""), Uuid::nil(), |p: Value| call("heartbeat.validate_transition", p, &env(""), 30));
        assert_eq!(v(json!({"expected_statuses":["queued"],"next_status":"running"}))["result"], json!({"valid":true,"sets_started_at":true,"sets_finished_at":false}));
        assert_eq!(v(json!({"expected_statuses":["succeeded"],"next_status":"running"}))["result"], json!({"valid":false,"reason":"illegal_transition","from":"succeeded","to":"running"}));
        for bad in [json!(null), json!([]), json!({}), json!({"expected_statuses":[],"next_status":"running"}), json!({"expected_statuses":["running"],"next_status":"bogus"}), json!({"expected_statuses":["running"],"next_status":"succeeded","x":1})] { assert_eq!(code(&v(bad)), -32602); }
        for (m, p) in [("heartbeat.claim_wakeup", json!({})), ("heartbeat.claim_wakeup", json!({"company_id":1,"agent_id":u})), ("heartbeat.transition_run_fenced", json!({"run_id":u,"company_id":u,"expected_statuses":[],"next_status":"running"})), ("heartbeat.transition_run_fenced", json!({"run_id":u,"company_id":u,"expected_statuses":["succeeded"],"next_status":"running"})), ("heartbeat.transition_run_fenced", json!({"run_id":u,"company_id":u,"expected_statuses":["running"],"next_status":"succeeded","y":2})), ("heartbeat.list_stale_runs", json!({"company_id":u})), ("heartbeat.list_stale_runs", json!({"company_id":u,"stale_before":"2026-01-01T00:00:00Z","limit":1,"z":0}))] { assert_eq!(code(&call(m, p, e, 30)), -32602, "{m}"); }
        assert_eq!(code(&call("heartbeat.nope", json!({}), e, 30)), -32601);
    }

    #[test]
    fn dsn_apply_or_reject_contract() {
        let p = json!({"company_id": Uuid::nil(), "agent_id": Uuid::nil()});
        assert_eq!(code(&call("heartbeat.claim_wakeup", p.clone(), &ProbeEnv::from_pairs(&[]), 30)), -32002); // no DATABASE_URL
        for d in ["", "host=127.0.0.1 port=1 user=u", "host=127.0.0.1 sslmode=disable", "host=/tmp user=u sslmode=disable", "host=127.0.0.1,127.0.0.2 user=u sslmode=disable", "host=192.0.2.1 port=1 user=u sslmode=disable"] {
            assert_eq!(code(&call("heartbeat.claim_wakeup", p.clone(), &env(d), 30)), -32002, "{d}"); }
        for x in ["sslmode=prefer", "sslmode=require", "hostaddr=1.1.1.1", "target_session_attrs=read-write", "tcp_user_timeout=1000", "keepalives=0", "keepalives_idle=10", "keepalives_interval=5", "keepalives_retries=3", "channel_binding=require", "load_balance_hosts=random", "options=-csearch_path=custom_schema"] {
            assert_eq!(code(&call("heartbeat.claim_wakeup", p.clone(), &env(&format!("host=127.0.0.1 port=1 user=u sslmode=disable {x}")), 30)), -32002, "{x}"); }
        let s = TcpSocket::new_v4().unwrap(); // keepalive() check: applied for =1, =0 rejected above
        (hooks().apply)(&s, &cfg("host=127.0.0.1 user=u sslmode=disable keepalives=1")).unwrap();
        assert!(socket2::SockRef::from(&s).keepalive().unwrap());
    }

    #[test]
    fn dial_gates_and_dns_cap() {
        let dials = Arc::new(AtomicUsize::new(0));
        let (dc, mut h) = (dials.clone(), hooks().clone());
        h.dial = Arc::new(move |_, _, _| { dc.fetch_add(1, Ordering::SeqCst); Box::pin(async { Err(io::Error::other("x")) }) });
        rt().block_on(async {
            let dl = Instant::now() + Duration::from_secs(5);
            assert_eq!(connect_checked(&cfg("postgres://u@192.0.2.1/db?sslmode=disable"), "192.0.2.1", 1, &h, dl).await.unwrap_err(), UNCONF);
            h.resolve = Arc::new(|_, p| Ok(vec![SocketAddr::new("192.0.2.1".parse().unwrap(), p)]));
            assert_eq!(connect_checked(&cfg("postgres://u@x.test/db?sslmode=disable"), "x.test", 1, &h, dl).await.unwrap_err(), UNCONF);
            h.resolve = Arc::new(|_, p| Ok(vec![SocketAddr::new("127.0.0.1".parse().unwrap(), p), SocketAddr::new("192.0.2.1".parse().unwrap(), p)]));
            assert_eq!(connect_checked(&cfg("postgres://u@m.test/db?sslmode=disable"), "m.test", 1, &h, dl).await.unwrap_err(), UNCONF);
            h.resolve = Arc::new(|_, p| Ok(vec![SocketAddr::new("127.0.0.1".parse().unwrap(), p)])); h.apply = Arc::new(|_, _| Err(io::Error::other("ka")));
            assert_eq!(connect_checked(&cfg("postgres://u@k.test/db?sslmode=disable"), "k.test", 1, &h, dl).await.unwrap_err(), UNCONF);
            assert_eq!(dials.load(Ordering::SeqCst), 0);
            h.apply = Arc::new(|_, _| Ok(()));
            h.resolve = Arc::new(|_, p| { std::thread::sleep(Duration::from_millis(400)); Ok(vec![SocketAddr::new("127.0.0.1".parse().unwrap(), p)]) });
            let c = cfg("postgres://u@h.test/db?sslmode=disable");
            let mk = |name: &'static str| { let (c, h, dl) = (c.clone(), h.clone(), Instant::now() + Duration::from_millis(150)); tokio::spawn(async move { connect_checked(&c, name, 1, &h, dl).await }) };
            let (j1, j2) = (mk("a.test"), mk("b.test"));
            tokio::time::sleep(Duration::from_millis(60)).await; // both permits held
            assert_eq!(connect_checked(&c, "c.test", 1, &h, Instant::now() + Duration::from_secs(1)).await.unwrap_err(), BUSY);
            assert_eq!((j1.await.unwrap().unwrap_err(), j2.await.unwrap().unwrap_err()), (T_OUT, T_OUT));
            tokio::time::sleep(Duration::from_millis(450)).await; // lookups finish -> permits released
            assert_eq!(connect_checked(&c, "d.test", 1, &h, Instant::now() + Duration::from_secs(2)).await.unwrap_err(), DBERR);
        });
    }

    #[test]
    fn hung_sockets_eof_and_recover() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (port, (sx, rx)) = (l.local_addr().unwrap().port(), mpsc::channel());
        std::thread::spawn(move || for _ in 0..4 { if let Ok((s, _)) = l.accept() { let _ = sx.send(s); } });
        let e = env(&format!("postgres://u@127.0.0.1:{port}/db?sslmode=disable"));
        let p = json!({"company_id": Uuid::nil(), "agent_id": Uuid::nil()});
        for _ in 0..4 {
            let r = call("heartbeat.claim_wakeup", p.clone(), &e, 150);
            assert_eq!((code(&r), r["error"]["data"].clone()), (-32001, json!({"outcome":"not_committed","retryable":true}))); }
        for _ in 0..4 {
            let mut s = rx.recv_timeout(Duration::from_secs(3)).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let (mut n, mut b) = (0usize, [0u8; 8192]);
            loop { match s.read(&mut b) { Ok(0) => break, Ok(m) => { n += m; assert!(n < (1 << 20)) }, Err(e) => panic!("no eof: {e}") } }
            assert!(n > 0); }
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert_eq!(code(&call("heartbeat.claim_wakeup", p, &env(&format!("postgres://u@127.0.0.1:{dead}/db?sslmode=disable")), 50)), -32004);
        assert!(crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &e)["result"]["ok"].as_bool().unwrap());
    }

    #[test]
    #[ignore] // live PG: set PAPERWORK_ENGINE_TEST_DATABASE_URL
    fn live_pg_claim_transition_stale_isolation() {
        let url = std::env::var("PAPERWORK_ENGINE_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() { return }
        let rt = rt(); // calls enter RUNTIME.block_on internally: must run outside block_on
        let c = rt.block_on(async {
            let (c, cn) = tokio_postgres::connect(&url, NoTls).await.unwrap();
            tokio::spawn(cn);
            for (i, (co, ag)) in [(Uuid::from_u128(9), Uuid::from_u128(7)), (Uuid::from_u128(8), Uuid::from_u128(6))].into_iter().enumerate() {
                let (wid, rid) = (Uuid::from_u128(11 + i as u128), Uuid::from_u128(21 + i as u128));
                c.batch_execute(&format!("DELETE FROM heartbeat_runs WHERE company_id='{co}'; DELETE FROM agent_wakeup_requests WHERE company_id='{co}'; DELETE FROM agents WHERE company_id='{co}'; DELETE FROM companies WHERE id='{co}'; INSERT INTO companies (id,name,issue_prefix) VALUES ('{co}','t','T{i}'); INSERT INTO agents (id,company_id,name) VALUES ('{ag}','{co}','t'); INSERT INTO agent_wakeup_requests (id,company_id,agent_id,source) VALUES ('{wid}','{co}','{ag}','t'); INSERT INTO heartbeat_runs (id,company_id,agent_id,status,updated_at) VALUES ('{rid}','{co}','{ag}','running',now()-interval '2 h')")).await.unwrap(); }
            c
        });
        let (a, b, e) = (Uuid::from_u128(9), Uuid::from_u128(8), env(&url));
        assert_eq!(call("heartbeat.claim_wakeup", json!({"company_id":a,"agent_id":Uuid::from_u128(6)}), &e, 5000)["result"]["claimed"], Value::Null); // B agent fenced
        assert_eq!(call("heartbeat.transition_run_fenced", json!({"run_id":Uuid::from_u128(22),"company_id":a,"expected_statuses":["running"],"next_status":"failed"}), &e, 5000)["result"]["applied"], false); // B run fenced
        let runs = call("heartbeat.list_stale_runs", json!({"company_id":a,"stale_before":"2030-01-01T00:00:00Z","limit":10}), &e, 5000)["result"]["runs"].as_array().unwrap().clone();
        assert_eq!((runs.len(), runs[0]["id"].clone()), (1, json!(Uuid::from_u128(21).to_string())));
        rt.block_on(async { c.batch_execute(&format!("DELETE FROM heartbeat_runs WHERE company_id in ('{a}','{b}'); DELETE FROM agent_wakeup_requests WHERE company_id in ('{a}','{b}'); DELETE FROM agents WHERE company_id in ('{a}','{b}'); DELETE FROM companies WHERE id in ('{a}','{b}')")).await.unwrap() });
    }
}
