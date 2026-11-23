#![forbid(unsafe_code)]
//! paperwork-engine: resident stdio JSON-RPC entrypoint. Stays alive across
//! requests until stdin closes; malformed lines are answered, never fatal.
use std::io;

fn main() -> io::Result<()> {
    let (stdin, stdout) = (io::stdin(), io::stdout());
    paperwork_engine::serve_stdio(stdin.lock(), stdout.lock())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    #[test]
    fn cursor_round_trip() {
        let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"engine.health\"}\n";
        let mut out = Vec::new();
        paperwork_engine::serve_stdio(Cursor::new(&input[..]), &mut out).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["result"]["ok"], true);
        assert_eq!(v["id"], 1);
    }
}
