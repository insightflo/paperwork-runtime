pub mod secret;

pub use secret::SecretRegistry;

use aho_corasick::{AhoCorasick, MatchKind};
use std::{borrow::Cow, collections::HashSet};

#[derive(Default)]
pub struct UserRedactor {
    cached_key: Option<(Vec<String>, Vec<String>, String)>, home_repls: Vec<(String, String)>,
    user_ac: Option<AhoCorasick>, user_repls: Vec<String>,
}

impl UserRedactor {
    pub fn redact_current_user_text(&mut self, input: &str, user_names: &[&str], home_dirs: &[&str], replacement: Option<&str>) -> String {
        if input.is_empty() { return String::new(); }
        let repl = replacement.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("*");
        self.ensure_compiled(user_names, home_dirs, repl);
        let mut cur: Cow<'_, str> = Cow::Borrowed(input);
        for (dir, masked_dir) in &self.home_repls {
            if cur.contains(dir.as_str()) { cur = Cow::Owned(cur.replace(dir.as_str(), masked_dir)); }
        }
        let Some(ac) = &self.user_ac else { return cur.into_owned() };
        let (text, mut out, mut last, mut cursor) = (cur.as_ref(), None::<String>, 0usize, 0usize);
        while let Some(m) = ac.find(&text[cursor..]) {
            let (start, end) = (cursor + m.start(), cursor + m.end());
            let prev_ok = text[..start].chars().next_back().is_none_or(|c| !is_user_boundary_char(c));
            let next_ok = text[end..].chars().next().is_none_or(|c| !is_user_boundary_char(c));
            if prev_ok && next_ok {
                let buf = out.get_or_insert_with(|| String::with_capacity(text.len()));
                buf.push_str(&text[last..start]);
                buf.push_str(&self.user_repls[m.pattern().as_usize()]);
                last = end; cursor = end;
            } else { cursor = start + text[start..].chars().next().map_or(1, char::len_utf8); }
        }
        match out { Some(mut buf) => { buf.push_str(&text[last..]); buf } None => cur.into_owned() }
    }

    fn ensure_compiled(&mut self, user_names: &[&str], home_dirs: &[&str], repl: &str) {
        if let Some((cu, ch, cr)) = &self.cached_key {
            if cr == repl && cu.iter().map(String::as_str).eq(user_names.iter().copied())
                && ch.iter().map(String::as_str).eq(home_dirs.iter().copied()) { return; }
        }
        self.home_repls = normalize_unique_desc(home_dirs).into_iter().map(|dir| {
            let last_seg = dir.trim_end_matches(['/', '\\']).split(['/', '\\']).rfind(|s| !s.is_empty()).unwrap_or("");
            let masked = if last_seg.is_empty() { repl.to_string() } else { replace_last_path_segment(&dir, &mask_user_name_for_logs(last_seg, repl)) };
            (dir, masked)
        }).collect();
        let norm_users = normalize_unique_desc(user_names);
        self.user_repls = norm_users.iter().map(|u| mask_user_name_for_logs(u, repl)).collect();
        self.user_ac = (!norm_users.is_empty()).then(|| AhoCorasick::builder().match_kind(MatchKind::LeftmostLongest).build(&norm_users).ok()).flatten();
        self.cached_key = Some((user_names.iter().map(|s| (*s).to_string()).collect(), home_dirs.iter().map(|s| (*s).to_string()).collect(), repl.to_string()));
    }
}

pub fn mask_user_name_for_logs(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    let Some(first) = trimmed.chars().next() else { return fallback.to_string() };
    format!("{first}{}", "*".repeat(trimmed.chars().count().saturating_sub(1).max(1)))
}

fn normalize_unique_desc(values: &[&str]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = values.iter().map(|s| s.trim()).filter(|s| !s.is_empty() && seen.insert(*s)).map(str::to_string).collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.encode_utf16().count()));
    out
}

fn replace_last_path_segment(path_value: &str, replacement: &str) -> String {
    let normalized = path_value.trim_end_matches(['/', '\\']);
    match normalized.rfind(['/', '\\']) { Some(pos) => format!("{}{}", &normalized[..=pos], replacement), None => replacement.to_string() }
}

fn is_user_boundary_char(c: char) -> bool { c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') }

#[cfg(not(test))]
mod ffi {
    use super::{SecretRegistry, UserRedactor};
    use std::cell::RefCell;
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr;

    #[allow(non_camel_case_types)] type napi_env = *mut c_void;
    #[allow(non_camel_case_types)] type napi_value = *mut c_void;
    #[allow(non_camel_case_types)] type napi_callback_info = *mut c_void;
    #[allow(non_camel_case_types)] type napi_status = i32;
    #[allow(non_camel_case_types)] type napi_valuetype = u32;
    #[allow(non_camel_case_types)] type napi_callback = Option<unsafe extern "C" fn(napi_env, napi_callback_info) -> napi_value>;
    const NAPI_OK: napi_status = 0;
    const NAPI_UNDEFINED: napi_valuetype = 0;
    const NAPI_NULL: napi_valuetype = 1;
    const NAPI_BOOLEAN: napi_valuetype = 2;
    const NAPI_STRING: napi_valuetype = 4;
    const NAPI_OBJECT: napi_valuetype = 6;

    extern "C" {
        fn napi_get_undefined(env: napi_env, result: *mut napi_value) -> napi_status; fn napi_get_null(env: napi_env, result: *mut napi_value) -> napi_status;
        fn napi_create_string_utf8(env: napi_env, str_: *const c_char, length: usize, result: *mut napi_value) -> napi_status;
        fn napi_create_function(env: napi_env, utf8name: *const c_char, length: usize, cb: napi_callback, data: *mut c_void, result: *mut napi_value) -> napi_status;
        fn napi_set_named_property(env: napi_env, object: napi_value, utf8name: *const c_char, value: napi_value) -> napi_status;
        fn napi_typeof(env: napi_env, value: napi_value, result: *mut napi_valuetype) -> napi_status; fn napi_get_value_bool(env: napi_env, value: napi_value, result: *mut bool) -> napi_status;
        fn napi_get_value_string_utf16(env: napi_env, value: napi_value, buf: *mut u16, bufsize: usize, result: *mut usize) -> napi_status;
        fn napi_is_array(env: napi_env, value: napi_value, result: *mut bool) -> napi_status; fn napi_get_array_length(env: napi_env, value: napi_value, result: *mut u32) -> napi_status;
        fn napi_get_element(env: napi_env, object: napi_value, index: u32, result: *mut napi_value) -> napi_status;
        fn napi_get_named_property(env: napi_env, object: napi_value, utf8name: *const c_char, result: *mut napi_value) -> napi_status;
        fn napi_get_cb_info(env: napi_env, cbinfo: napi_callback_info, argc: *mut usize, argv: *mut napi_value, this_arg: *mut napi_value, data: *mut *mut c_void) -> napi_status;
        fn napi_throw_type_error(env: napi_env, code: *const c_char, msg: *const c_char) -> napi_status;
    }

    #[derive(Default)]
    struct AddonState { secrets: SecretRegistry, user: UserRedactor }

    // Per-thread registry state: survives repeated process.dlopen within one thread and keeps
    // Worker threads isolated (napi env instance data does not survive Node's re-registration).
    thread_local! { static STATE: RefCell<AddonState> = RefCell::new(AddonState::default()) }

    fn with_state<R>(f: impl FnOnce(&mut AddonState) -> R) -> Option<R> {
        STATE.try_with(|st| st.try_borrow_mut().ok().map(|mut st| f(&mut st))).ok().flatten()
    }
    unsafe fn js_null(env: napi_env) -> napi_value { let mut v = ptr::null_mut(); napi_get_null(env, &mut v); v }
    unsafe fn js_undef(env: napi_env) -> napi_value { let mut v = ptr::null_mut(); napi_get_undefined(env, &mut v); v }
    unsafe fn js_str(env: napi_env, s: &str) -> napi_value {
        let mut v = ptr::null_mut(); napi_create_string_utf8(env, s.as_ptr().cast(), s.len(), &mut v); v
    }
    unsafe fn throw_type_err(env: napi_env, msg: &CStr) -> napi_value {
        napi_throw_type_error(env, ptr::null(), msg.as_ptr()); ptr::null_mut()
    }
    unsafe fn val_type(env: napi_env, v: napi_value) -> napi_valuetype {
        let mut ty = NAPI_UNDEFINED; if napi_typeof(env, v, &mut ty) == NAPI_OK { ty } else { NAPI_UNDEFINED }
    }
    unsafe fn get_bool(env: napi_env, v: napi_value) -> Option<bool> {
        let mut b = false; (val_type(env, v) == NAPI_BOOLEAN && napi_get_value_bool(env, v, &mut b) == NAPI_OK).then_some(b)
    }
    unsafe fn get_named(env: napi_env, obj: napi_value, key: &CStr) -> napi_value {
        let mut out = ptr::null_mut(); if napi_get_named_property(env, obj, key.as_ptr(), &mut out) == NAPI_OK { out } else { ptr::null_mut() }
    }
    unsafe fn get_utf16(env: napi_env, v: napi_value) -> Result<Option<String>, ()> {
        if val_type(env, v) != NAPI_STRING { return Err(()); }
        let (mut len, mut copied) = (0usize, 0usize);
        if napi_get_value_string_utf16(env, v, ptr::null_mut(), 0, &mut len) != NAPI_OK { return Err(()); }
        let mut buf = vec![0u16; len + 1];
        if napi_get_value_string_utf16(env, v, buf.as_mut_ptr(), buf.len(), &mut copied) != NAPI_OK { return Err(()); }
        buf.truncate(copied);
        Ok(String::from_utf16(&buf).ok())
    }
    unsafe fn get_str_array(env: napi_env, v: napi_value, fail_surrogate: bool) -> Result<Option<Vec<String>>, ()> {
        let (mut is_arr, mut len) = (false, 0u32);
        if napi_is_array(env, v, &mut is_arr) != NAPI_OK || !is_arr || napi_get_array_length(env, v, &mut len) != NAPI_OK { return Err(()); }
        let mut out = Vec::with_capacity(len as usize);
        for i in 0..len {
            let mut elem = ptr::null_mut();
            if napi_get_element(env, v, i, &mut elem) != NAPI_OK { return Err(()); }
            match get_utf16(env, elem)? { Some(s) => out.push(s), None if fail_surrogate => return Ok(None), None => {} }
        }
        Ok(Some(out))
    }
    unsafe fn cb_args<const N: usize>(env: napi_env, info: napi_callback_info) -> ([napi_value; N], usize) {
        let (mut argv, mut argc) = ([ptr::null_mut(); N], N);
        napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), ptr::null_mut(), ptr::null_mut());
        (argv, argc)
    }
    unsafe fn opt_str_array(env: napi_env, v: napi_value) -> Result<Option<Vec<String>>, ()> {
        if v.is_null() || matches!(val_type(env, v), NAPI_UNDEFINED | NAPI_NULL) { Ok(Some(Vec::new())) } else { get_str_array(env, v, true) }
    }
    unsafe fn redact_text_js(env: napi_env, info: napi_callback_info, embedded: bool) -> napi_value {
        let (argv, argc) = cb_args::<3>(env, info);
        let Ok(opt) = (if argc >= 1 { get_utf16(env, argv[0]) } else { Err(()) }) else { return throw_type_err(env, c"Expected string"); };
        let Some(input) = opt else { return js_null(env); };
        let (emails, keep) = if argc < 2 { (false, false) } else {
            match val_type(env, argv[1]) {
                NAPI_BOOLEAN => (get_bool(env, argv[1]).unwrap_or(false), argc >= 3 && get_bool(env, argv[2]).unwrap_or(false)),
                NAPI_OBJECT => (get_bool(env, get_named(env, argv[1], c"emails")).unwrap_or(false), get_bool(env, get_named(env, argv[1], c"keepUnscanned")).unwrap_or(false)),
                _ => (false, false),
            }
        };
        let res = with_state(|st| if embedded { st.secrets.redact_embedded_json(&input, emails, keep) } else { st.secrets.redact_sensitive_text(&input, emails, keep) }).flatten();
        match res { Some(out) => js_str(env, &out), None => js_null(env) }
    }
    unsafe extern "C" fn set_registered_literal_secrets_js(env: napi_env, info: napi_callback_info) -> napi_value {
        let (argv, argc) = cb_args::<1>(env, info);
        let Ok(Some(vals)) = (if argc >= 1 { get_str_array(env, argv[0], false) } else { Err(()) }) else { return throw_type_err(env, c"Expected string array"); };
        let refs: Vec<&str> = vals.iter().map(String::as_str).collect();
        with_state(|st| st.secrets.set_literal_secrets(&refs));
        js_undef(env)
    }
    unsafe extern "C" fn register_runtime_secrets_js(env: napi_env, info: napi_callback_info) -> napi_value {
        let (argv, argc) = cb_args::<2>(env, info);
        let Ok(Some(vals)) = (if argc >= 1 { get_str_array(env, argv[0], false) } else { Err(()) }) else { return throw_type_err(env, c"Expected string array"); };
        let allow_short = if argc >= 2 {
            match val_type(env, argv[1]) {
                NAPI_BOOLEAN => get_bool(env, argv[1]).unwrap_or(false),
                NAPI_OBJECT => get_bool(env, get_named(env, argv[1], c"allowShort")).unwrap_or(false),
                _ => false,
            }
        } else { false };
        let refs: Vec<&str> = vals.iter().map(String::as_str).collect();
        with_state(|st| st.secrets.register_secrets(&refs, allow_short));
        js_undef(env)
    }
    unsafe extern "C" fn clear_registered_runtime_secrets_js(env: napi_env, _info: napi_callback_info) -> napi_value {
        with_state(|st| st.secrets.clear()); js_undef(env)
    }
    unsafe extern "C" fn redact_sensitive_text_js(env: napi_env, info: napi_callback_info) -> napi_value { redact_text_js(env, info, false) }
    unsafe extern "C" fn redact_embedded_json_js(env: napi_env, info: napi_callback_info) -> napi_value { redact_text_js(env, info, true) }
    unsafe extern "C" fn redact_current_user_text_js(env: napi_env, info: napi_callback_info) -> napi_value {
        let (argv, argc) = cb_args::<4>(env, info);
        let Ok(opt_in) = (if argc >= 1 { get_utf16(env, argv[0]) } else { Err(()) }) else { return throw_type_err(env, c"Expected string"); };
        let Some(input) = opt_in else { return js_null(env); };
        if input.is_empty() { return argv[0]; }
        let mut is_arr = false;
        let is_obj = argc >= 2 && val_type(env, argv[1]) == NAPI_OBJECT && napi_is_array(env, argv[1], &mut is_arr) == NAPI_OK && !is_arr;
        if is_obj && get_bool(env, get_named(env, argv[1], c"enabled")) == Some(false) { return argv[0]; }
        let (u_val, h_val, r_val) = if is_obj {
            (get_named(env, argv[1], c"userNames"), get_named(env, argv[1], c"homeDirs"), get_named(env, argv[1], c"replacement"))
        } else {
            (if argc >= 2 { argv[1] } else { ptr::null_mut() }, if argc >= 3 { argv[2] } else { ptr::null_mut() }, if argc >= 4 { argv[3] } else { ptr::null_mut() })
        };
        let (Ok(u_opt), Ok(h_opt)) = (opt_str_array(env, u_val), opt_str_array(env, h_val)) else { return throw_type_err(env, c"Expected string array"); };
        let (Some(users), Some(homes)) = (u_opt, h_opt) else { return js_null(env); };
        let repl = if r_val.is_null() || matches!(val_type(env, r_val), NAPI_UNDEFINED | NAPI_NULL) { None } else {
            match get_utf16(env, r_val) { Ok(Some(s)) => Some(s), Ok(None) => return js_null(env), Err(()) => return throw_type_err(env, c"Expected string") }
        };
        let (u_refs, h_refs): (Vec<&str>, Vec<&str>) = (users.iter().map(String::as_str).collect(), homes.iter().map(String::as_str).collect());
        match with_state(|st| st.user.redact_current_user_text(&input, &u_refs, &h_refs, repl.as_deref())) {
            Some(out) => js_str(env, &out), None => js_null(env),
        }
    }

    #[no_mangle] pub extern "C" fn node_api_module_get_api_version_v1() -> i32 { 8 }
    #[no_mangle]
    pub unsafe extern "C" fn napi_register_module_v1(env: napi_env, exports: napi_value) -> napi_value {
        let funcs: [(&CStr, napi_callback); 6] = [
            (c"setRegisteredLiteralSecrets", Some(set_registered_literal_secrets_js)),
            (c"registerRuntimeSecrets", Some(register_runtime_secrets_js)),
            (c"clearRegisteredRuntimeSecrets", Some(clear_registered_runtime_secrets_js)),
            (c"redactSensitiveText", Some(redact_sensitive_text_js)),
            (c"redactEmbeddedJson", Some(redact_embedded_json_js)),
            (c"redactCurrentUserText", Some(redact_current_user_text_js)),
        ];
        for (name, cb) in funcs {
            let mut fn_val = ptr::null_mut();
            if napi_create_function(env, name.as_ptr(), name.to_bytes().len(), cb, ptr::null_mut(), &mut fn_val) == NAPI_OK {
                napi_set_named_property(env, exports, name.as_ptr(), fn_val);
            }
        }
        exports
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_secrets_and_urls() {
        let mut reg = SecretRegistry::default();
        let raw = "x7Kq/9+secret=val";
        reg.register_secrets(&[raw, "acme-corp.internal", "abc12345"], false);
        assert_eq!(reg.redact_sensitive_text(&format!("token={raw}"), false, false).as_deref(), Some("token=[redacted]"));
        assert_eq!(reg.redact_sensitive_text("encoded=x7Kq%2F9%2Bsecret%3Dval", false, false).as_deref(), Some("encoded=[redacted]"));
        assert_eq!(reg.redact_sensitive_text(r#"escaped="x7Kq/9+secret=val""#, false, false).as_deref(), Some(r#"escaped="[redacted]""#));
        let url = reg.redact_sensitive_text("fetching https://acme-corp.internal/v1 and X-Secret: acme-corp.internal", false, false).unwrap();
        assert!(url.contains("https://acme-corp.internal/v1") && !url.contains("X-Secret: acme-corp.internal"));
        assert_eq!(reg.redact_sensitive_text("Authorization: abc12345_extra_tail", false, false).as_deref(), Some("Authorization: [redacted]"));
        reg.set_literal_secrets(&["raw%20pre"]);
        assert_eq!(reg.redact_sensitive_text("x=raw%20pre y=raw%2520pre", false, false).as_deref(), Some("x=[redacted] y=raw%2520pre"));
        reg.clear();
        assert_eq!(reg.redact_sensitive_text("x=raw%20pre", false, false).as_deref(), Some("x=raw%20pre"));
    }

    #[test]
    fn text_rules_boundaries_and_fallbacks() {
        let reg = SecretRegistry::default();
        assert_eq!(reg.redact_sensitive_text("foo_whsec_12345678/ghp_12345678", false, false).as_deref(), Some("foo_whsec_12345678/[redacted]"));
        assert_eq!(reg.redact_sensitive_text("ASIAABCDEFGHIJKLMNOP", false, false).as_deref(), Some("[redacted]"));
        assert_eq!(reg.redact_sensitive_text("ASIAABCDEFGHIJKLMNOPx", false, false).as_deref(), Some("ASIAABCDEFGHIJKLMNOPx"));
        assert_eq!(reg.redact_sensitive_text("ASIAABCDEFGHIJKLMNOPghp_12345678", false, false).as_deref(), Some("ASIAABCDEFGHIJKLMNOPghp_12345678"));
        assert_eq!(reg.redact_sensitive_text("Cookie: a=\"1\"; b=\"2\"\nkeep", false, false).as_deref(), Some("Cookie: [redacted]\nkeep"));
        assert_eq!(reg.redact_sensitive_text("-----BEGIN RSA PRIVATE KEY-----\nAAAA1234567890+/==", false, false).as_deref(), Some("[redacted]"));
        assert_eq!(reg.redact_sensitive_text("https://ex.com?code=1234abcd90&key=[redacted]&sig=abcdefghij", false, false).as_deref(), Some("https://ex.com?code=[redacted]&key=[redacted]&sig=abcdefghij"));
        assert_eq!(reg.redact_sensitive_text("a@b.com", true, false).as_deref(), Some("[redacted-email]"));
        assert_eq!(reg.redact_sensitive_text("{\"10\":\"Bearer verysecret1234\",\"2\":\"ok\"}", false, false).as_deref(), Some("{\"2\":\"ok\",\"10\":\"[redacted]\"}"));
        assert_eq!(reg.redact_sensitive_text("{\"a\":\"\\uD83D\"}", false, false), None);
        assert_eq!(reg.redact_sensitive_text("{\"secret\":\"x\",\"f\":1.5}", false, false), None);
        assert_eq!(reg.redact_embedded_json("prefix {\"headers\":{\"X\":\"v\"}} tail", false, false).as_deref(), Some("prefix {\"headers\":{\"X\":\"[redacted]\"}} tail"));
    }

    #[test]
    fn current_user_redaction() {
        let mut ur = UserRedactor::default();
        let out = ur.redact_current_user_text("cwd=/Users/alice/app alice said alice/p apaperclipuserz", &["alice", "paperclipuser"], &["/Users/alice"], None);
        assert_eq!(out, "cwd=/Users/a****/app a**** said a****/p apaperclipuserz");
    }
}
