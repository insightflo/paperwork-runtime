//! zod `artifactContractSchema.safeParse` success predicate, ported from
//! packages/shared/src/validators/artifact-contract.ts + qa-config.ts.
//! Input domain is parsed JSON: string bounds count UTF-16 units (zod `.length`),
//! `.strict()` objects reject unknown keys, and absent keys model `undefined`.
use serde_json::{Map, Value};

fn u16len(s: &str) -> usize { s.chars().map(char::len_utf16).sum() }
fn slen(s: &str, lo: usize, hi: usize) -> bool { let n = u16len(s); n >= lo && n <= hi }
/// `^[A-Za-z0-9][A-Za-z0-9._-]*$`
fn re_slug(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && c.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}
/// Required key: present and valid.
fn need(m: &Map<String, Value>, k: &str, f: impl Fn(&Value) -> bool) -> bool { m.get(k).is_some_and(f) }
/// Optional key: absent or valid.
fn opt(v: Option<&Value>, f: impl Fn(&Value) -> bool) -> bool { v.is_none_or(f) }
/// `.strict()` object: object type plus no unknown keys.
fn strict<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let m = v.as_object()?;
    m.keys().all(|k| keys.contains(&k.as_str())).then_some(m)
}
fn need_v<'a>(m: &'a Map<String, Value>, k: &str) -> &'a Value { m.get(k).unwrap_or(&Value::Null) }
fn str_len(v: &Value, lo: usize, hi: usize) -> bool { v.as_str().is_some_and(|s| slen(s, lo, hi)) }
/// `^[A-Za-z][A-Za-z0-9_-]*$`, max 100.
fn is_param(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        u16len(s) <= 100 && {
            let mut c = s.chars();
            c.next().is_some_and(|c| c.is_ascii_alphabetic())
                && c.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        }
    })
}
fn is_version(v: &Value) -> bool { v.as_str().is_some_and(|s| slen(s, 1, 128) && re_slug(s)) }
fn file_name_str(s: &str) -> bool { slen(s, 1, 255) && s != "." && s != ".." && re_slug(s) }
fn is_file_name(v: &Value) -> bool { v.as_str().is_some_and(file_name_str) }
/// `^(?:\/(?:[^~\x00-\x1f]|~[01])*)*$` (u flag), max 500.
fn is_pointer(v: &Value) -> bool {
    let Some(s) = v.as_str() else { return false };
    if u16len(s) > 500 || (!s.is_empty() && !s.starts_with('/')) {
        return false;
    }
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if (c as u32) <= 0x1f {
            return false;
        }
        if c == '~' && !matches!(it.next(), Some('0' | '1')) {
            return false;
        }
    }
    true
}
/// zod `z.number().int().nonnegative().max(10000)`.
fn is_minimum(v: &Value) -> bool {
    v.as_f64().is_some_and(|f| f.fract() == 0.0 && (0.0..=10000.0).contains(&f))
}
fn is_pointers(v: &Value) -> bool {
    v.as_array().is_some_and(|a| !a.is_empty() && a.len() <= 100 && a.iter().all(is_pointer))
}
fn is_texts(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        !a.is_empty() && a.len() <= 100 && a.iter().all(|e| str_len(e, 1, 500))
    })
}

// qaConfigSchema rule params shapes.
fn p_empty(p: &Value) -> bool { strict(p, &[]).is_some() }
fn p_min_source_links(p: &Value) -> bool {
    strict(p, &["min", "pointers"])
        .is_some_and(|m| need(m, "min", is_minimum) && opt(m.get("pointers"), is_pointers))
}
fn p_tag_count(p: &Value) -> bool {
    strict(p, &["pointer", "min", "max"]).is_some_and(|m| {
        opt(m.get("pointer"), is_pointer)
            && need(m, "min", is_minimum)
            && opt(m.get("max"), is_minimum)
            && (m.get("max").is_none()
                || m.get("max").and_then(Value::as_f64) >= m.get("min").and_then(Value::as_f64))
    })
}
fn p_required_fields(p: &Value) -> bool {
    strict(p, &["pointers"]).is_some_and(|m| need(m, "pointers", is_pointers))
}
fn p_no_template_remnants(p: &Value) -> bool {
    strict(p, &["patterns"]).is_some_and(|m| need(m, "patterns", is_texts))
}
fn p_asset_existence(p: &Value) -> bool {
    strict(p, &["pointers"]).is_some_and(|m| opt(m.get("pointers"), is_pointers))
}

const RULE_KEYS: [&str; 13] = ["provenance", "result-format", "no-sensitive-data", "no-external-script",
    "no-external-iframe", "https-links", "min-source-links", "links-reachable", "uploaded-asset-required",
    "tag-count", "required-fields", "no-template-remnants", "asset-existence"];
const MANDATORY_RULES: [&str; 6] = ["provenance", "result-format", "no-sensitive-data",
    "no-external-script", "no-external-iframe", "https-links"];

fn rule(v: Option<&Value>, params: fn(&Value) -> bool) -> bool {
    opt(v, |r| {
        strict(r, &["enabled", "params"])
            .is_some_and(|m| opt(m.get("enabled"), Value::is_boolean) && opt(m.get("params"), params))
    })
}
/// `mandatory` rules carry `enabled: z.literal(true).optional()`.
fn rule_mandatory(v: Option<&Value>) -> bool {
    opt(v, |r| {
        strict(r, &["enabled", "params"]).is_some_and(|m| {
            opt(m.get("enabled"), |e| e == &Value::Bool(true)) && opt(m.get("params"), p_empty)
        })
    })
}
fn qa_config_ok(v: &Value) -> bool {
    let Some(m) = strict(v, &["rules"]) else { return false };
    let Some(r) = strict(need_v(m, "rules"), &RULE_KEYS) else { return false };
    MANDATORY_RULES.iter().all(|k| rule_mandatory(r.get(*k)))
        && rule(r.get("min-source-links"), p_min_source_links)
        && rule(r.get("links-reachable"), p_empty)
        && rule(r.get("uploaded-asset-required"), p_empty)
        && rule(r.get("tag-count"), p_tag_count)
        && rule(r.get("required-fields"), p_required_fields)
        && rule(r.get("no-template-remnants"), p_no_template_remnants)
        && rule(r.get("asset-existence"), p_asset_existence)
}

const LEGACY_FIELDS: [&str; 11] = ["ok", "command", "mode", "section", "id", "date", "scope", "title",
    "publishedAt", "publicUrl", "cms"];

fn publication_ok(v: &Value) -> bool {
    let Some(m) = strict(v, &[
        "identity", "bindings", "command", "commandKeySeparator",
        "audience", "legacyMapping", "publishedAt",
    ]) else { return false };
    opt(m.get("identity"), |i| {
        strict(i, &["param", "sourcePathParam", "sourceFieldParam", "format", "dateParam"]).is_some_and(|im| {
            ["param", "sourcePathParam", "sourceFieldParam", "dateParam"].iter().all(|k| opt(im.get(*k), is_param))
                && opt(im.get("format"), |f| f.as_str().is_some_and(|s| s == "literal" || s == "date-prefixed-slug"))
        })
    }) && opt(m.get("bindings"), |b| {
        b.as_array().is_some_and(|a| a.len() <= 50 && a.iter().all(|e| {
            strict(e, &["resultPointer", "parameter", "optional"]).is_some_and(|em| {
                is_pointer(need_v(em, "resultPointer"))
                    && is_param(need_v(em, "parameter"))
                    && opt(em.get("optional"), Value::is_boolean)
            })
        }))
    }) && opt(m.get("command"), |c| str_len(c, 1, 100))
        && opt(m.get("commandKeySeparator"), |c| str_len(c, 1, 10))
        && opt(m.get("audience"), |a| {
            strict(a, &["parameter", "privateValue", "privateResult", "defaultResult"]).is_some_and(|am| {
                is_param(need_v(am, "parameter"))
                    && need(am, "privateValue", Value::is_string)
                    && need(am, "privateResult", Value::is_string)
                    && need(am, "defaultResult", Value::is_string)
            })
        })
        && opt(m.get("legacyMapping"), |l| {
            strict(l, &["fields", "contentMode", "htmlMode", "contentDigest", "htmlDigest", "qaDigest", "assets", "ancillary"]).is_some_and(|lm| {
                legacy_fields_ok(need_v(lm, "fields"))
                    && need(lm, "contentMode", Value::is_string)
                    && need(lm, "htmlMode", Value::is_string)
                    && ["contentDigest", "htmlDigest", "qaDigest", "assets", "ancillary"]
                        .iter().all(|k| is_pointer(need_v(lm, k)))
            })
        })
        && opt(m.get("publishedAt"), |p| {
            strict(p, &["resultPointer", "dateParam", "suffix"]).is_some_and(|pm| {
                is_pointer(need_v(pm, "resultPointer"))
                    && is_param(need_v(pm, "dateParam"))
                    && str_len(need_v(pm, "suffix"), 0, 64)
            })
        })
}

fn legacy_fields_ok(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|m| m.iter().all(|(k, val)| LEGACY_FIELDS.contains(&k.as_str()) && is_pointer(val)))
}
/// String value unless empty: `!fields?.x` is JS truthiness, so `""` is falsy.
fn non_empty_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `superRefine` tail: runs on the validated object when `role === "publication"`.
fn publication_refine(m: &Map<String, Value>) -> bool {
    let cfg = m.get("publication");
    let id = cfg.and_then(|c| c.get("identity"));
    let ts = cfg.and_then(|c| c.get("publishedAt"));
    let id_ok = id.and_then(|i| i.get("param")).is_some()
        || id.is_some_and(|i| {
            i.get("sourcePathParam").is_some()
                && i.get("sourceFieldParam").is_some()
                && i.get("format").is_some()
                && (i.get("format").and_then(Value::as_str) == Some("literal")
                    || i.get("dateParam").is_some())
        });
    if !id_ok {
        return false;
    }
    let legacy = m.get("resultAdapter").and_then(Value::as_str) == Some("legacy-publication");
    let fields = cfg.and_then(|c| c.get("legacyMapping")).and_then(|l| l.get("fields"));
    let (f_date, f_pub) = if legacy {
        (
            non_empty_str(fields.and_then(|f| f.get("date"))),
            non_empty_str(fields.and_then(|f| f.get("publishedAt"))),
        )
    } else {
        (Some("/date"), Some("/publishedAt"))
    };
    if ts.is_none()
        || f_pub.is_none()
        || ts.and_then(|t| t.get("resultPointer")).and_then(Value::as_str) != f_pub
    {
        return false;
    }
    f_date.is_some()
        && cfg.and_then(|c| c.get("bindings")).and_then(Value::as_array).is_some_and(|b| {
            b.iter().any(|e| {
                e.get("resultPointer").and_then(Value::as_str) == f_date
                    && e.get("parameter").and_then(Value::as_str)
                        == ts.and_then(|t| t.get("dateParam")).and_then(Value::as_str)
            })
        })
}

const TOP_KEYS: [&str; 14] = ["role", "resultFileName", "resultSchemaVersion", "resultAdapter",
    "inputParams", "consumerParams", "deploymentFiles", "bundleManifest", "assetDiscovery",
    "inputEnvelopeVersion", "defaultRules", "publication", "readback", "previewProvider"];

/// `artifactContractSchema.safeParse(v).success` for JSON-representable input.
pub fn artifact_contract_ok(v: Option<&Value>) -> bool {
    let Some(m) = v.and_then(|x| strict(x, &TOP_KEYS)) else { return false };
    let Some(role) = m.get("role").and_then(Value::as_str) else { return false };
    matches!(role, "qa" | "publication" | "publication-verify")
        && need(m, "resultFileName", is_file_name)
        && need(m, "resultSchemaVersion", is_version)
        && m.get("resultAdapter").and_then(Value::as_str)
            .is_some_and(|a| matches!(a, "generic" | "legacy-qa" | "legacy-publication"))
        && strict(need_v(m, "inputParams"), &["content", "html", "assetsDir", "manifest", "out"])
            .is_some_and(|im| {
                ["content", "html", "assetsDir", "manifest", "out"]
                    .iter().all(|k| opt(im.get(*k), is_param))
            })
        && opt(m.get("consumerParams"), |c| {
            strict(c, &["receipt", "content", "html"]).is_some_and(|cm| {
                is_param(need_v(cm, "receipt"))
                    && opt(cm.get("content"), is_param)
                    && opt(cm.get("html"), is_param)
            })
        })
        && m.get("deploymentFiles").and_then(Value::as_array).is_some_and(|a| {
            !a.is_empty() && a.len() <= 100 && a.iter().all(|e| {
                e.as_str().is_some_and(|s| slen(s, 1, 1000) && s.split('/').all(file_name_str))
            })
        })
        && opt(m.get("bundleManifest"), |b| {
            strict(b, &["fileName", "schemaVersion", "ancillaryRoles"]).is_some_and(|bm| {
                is_file_name(need_v(bm, "fileName"))
                    && opt(bm.get("schemaVersion"), is_version)
                    && opt(bm.get("ancillaryRoles"), |a| {
                        a.as_array().is_some_and(|ar| ar.len() <= 100 && ar.iter().all(|e| str_len(e, 1, 100)))
                    })
            })
        })
        && opt(m.get("assetDiscovery"), |a| {
            a.as_array().is_some_and(|ar| ar.len() <= 100 && ar.iter().all(is_pointer))
        })
        && need(m, "inputEnvelopeVersion", is_version)
        && opt(m.get("defaultRules"), qa_config_ok)
        && opt(m.get("publication"), publication_ok)
        && opt(m.get("readback"), |r| {
            strict(r, &["rejectTitlePatterns"]).is_some_and(|rm| {
                rm.get("rejectTitlePatterns").and_then(Value::as_array)
                    .is_some_and(|a| a.len() <= 100 && a.iter().all(|e| str_len(e, 1, 500)))
            })
        })
        && opt(m.get("previewProvider"), |p| str_len(p, 1, 100))
        && (role != "publication" || publication_refine(m))
}
