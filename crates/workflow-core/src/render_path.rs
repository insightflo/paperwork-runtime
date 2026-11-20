//! [파일 목적] Node path.dirname/join 에뮬레이션 — render.rs 의 Stage 3 모듈 분리(300줄 규칙).
//!   separator 페이로드로 posix('/')·win32('\\') 양쪽 의미론을 커버한다(parity F5).
//! [외부 연결] consumer: render.rs 의 {$steps.*.workProductDir|siblingAssetsDir} 치환.

fn is_sep(c: char, sep: char) -> bool {
    c == sep || (sep == '\\' && c == '/')
}

/// win32 드라이브/UNC 루트 인식 포함. 반환 (root_end_index, absolute).
fn root_end(chars: &[char], sep: char) -> (usize, bool) {
    let len = chars.len();
    if sep == '/' {
        return match chars.first() {
            Some('/') => (1, true),
            _ => (0, false),
        };
    }
    if len >= 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
        return if len > 2 && is_sep(chars[2], sep) {
            (3, true)
        } else {
            (2, false)
        };
    }
    if len >= 2 && is_sep(chars[0], sep) && is_sep(chars[1], sep) {
        // UNC: \\server\share 까지가 루트. server/share 부재 시 선행 sep 만 루트.
        let mut j = 2;
        for i in 0..2 {
            while j < len && is_sep(chars[j], sep) {
                j += 1;
            }
            let start = j;
            while j < len && !is_sep(chars[j], sep) {
                j += 1;
            }
            if j == start || (i == 0 && j >= len) {
                return (1, true);
            }
        }
        return (j, true);
    }
    if len >= 1 && is_sep(chars[0], sep) {
        return (1, true);
    }
    (0, false)
}

/// Node path.dirname — 루트 이전 인덱스는 구분 경계로 세지 않는다(posix matchedSlash 스캔 재현).
pub(crate) fn dirname(p: &str, sep: char) -> String {
    let chars: Vec<char> = p.chars().collect();
    let (root, _) = root_end(&chars, sep);
    let lo = root.max(1);
    let last_char = (lo..chars.len()).rev().find(|&i| !is_sep(chars[i], sep));
    let end = last_char.and_then(|t| (lo..t).rev().find(|&i| is_sep(chars[i], sep)));
    match end {
        None if root == 0 => ".".to_string(),
        None => chars[..root].iter().collect(),
        Some(1) if sep == '/' && root == 1 => "//".to_string(), // posix '//' 루트 quirk.
        Some(e) => chars[..e].iter().collect(),
    }
}

/// Node path.join(dir, "assets") — 단순 sep 연결 후 normalize(`.`/`..`/중복 sep 해소).
pub(crate) fn join_assets(dir: &str, sep: char) -> String {
    let joined: Vec<char> = format!("{dir}{sep}assets").chars().collect();
    let (root, absolute) = root_end(&joined, sep);
    let rest: String = joined[root..].iter().collect();
    let mut segs: Vec<String> = Vec::new();
    for seg in rest.split(|c| is_sep(c, sep)) {
        match seg {
            "" | "." => {}
            ".." if segs.last().is_some_and(|s| s != "..") => drop(segs.pop()),
            ".." if !absolute => segs.push(seg.to_string()),
            ".." => {}
            _ => segs.push(seg.to_string()),
        }
    }
    let root_str: String = joined[..root].iter().collect();
    if segs.is_empty() {
        return if root_str.is_empty() {
            ".".to_string()
        } else {
            root_str
        };
    }
    // UNC 루트("\\\\srv\\sh" 또는 "//srv/sh")만 tail 앞에 sep 를 추가한다.
    let unc = root_str.chars().take(2).filter(|c| is_sep(*c, sep)).count() == 2;
    let sep = sep.to_string();
    format!(
        "{root_str}{}{}",
        if unc { sep.as_str() } else { "" },
        segs.join(&sep)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_path_semantics() {
        assert_eq!(dirname("//a", '/'), "//");
        assert_eq!(dirname("a//b", '/'), "a/");
        assert_eq!(dirname("/", '/'), "/");
        assert_eq!(dirname("nope", '/'), ".");
        assert_eq!(join_assets(".", '/'), "assets");
        assert_eq!(join_assets("/", '/'), "/assets");
        assert_eq!(join_assets("a/../b", '/'), "b/assets");
    }
}
