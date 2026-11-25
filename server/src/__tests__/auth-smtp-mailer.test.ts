import net, { type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPasswordResetSender } from "../auth/password-reset.js";
import {
  readSmtpConfigFromEnv,
  resolveSmtpTlsServername,
  sendSmtpMail,
  type SmtpConfig,
} from "../auth/smtp-mailer.js";

type MockSmtpServer = {
  port: number;
  connections: () => number;
  transcript: () => string;
  close: () => Promise<void>;
};

async function startMockSmtpServer(opts: { authResponse?: string; ehloResponse?: string } = {}): Promise<MockSmtpServer> {
  let transcript = "";
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 localhost ESMTP\r\n");

    let buffer = "";
    let inData = false;
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      transcript += text;
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 queued\r\n");
          }
        } else {
          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO ")) {
            socket.write(opts.ehloResponse ?? "250-localhost\r\n250-AUTH PLAIN\r\n250 OK\r\n");
          } else if (upper.startsWith("AUTH PLAIN")) {
            socket.write(opts.authResponse ?? "235 2.7.0 authenticated\r\n");
          } else if (upper.startsWith("MAIL FROM:") || upper.startsWith("RCPT TO:")) {
            socket.write("250\r\n");
          } else if (upper === "DATA") {
            inData = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (upper.startsWith("QUIT")) {
            socket.write("221 2.0.0 bye\r\n");
          } else {
            socket.write("502 5.5.2 unsupported\r\n");
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    connections: () => connections,
    transcript: () => transcript,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function smtpConfig(port: number): SmtpConfig {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    user: "smtp-user",
    pass: "smtp-pass",
    from: "reset@example.com",
  };
}

describe("readSmtpConfigFromEnv", () => {
  it("reads PAPERWORK_SMTP settings and applies secure-aware port defaults", () => {
    expect(readSmtpConfigFromEnv({
      PAPERWORK_SMTP_HOST: "smtp.example.com",
      PAPERWORK_SMTP_USER: "mailer",
      PAPERWORK_SMTP_PASS: "secret",
      PAPERWORK_SMTP_FROM: "reset@example.com",
    })).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "mailer",
      pass: "secret",
      from: "reset@example.com",
    });

    expect(readSmtpConfigFromEnv({
      PAPERWORK_SMTP_HOST: "smtp.example.com",
      PAPERWORK_SMTP_FROM: "reset@example.com",
      PAPERWORK_SMTP_SECURE: "true",
    })).toMatchObject({ port: 465, secure: true });
    expect(readSmtpConfigFromEnv({ PAPERWORK_SMTP_HOST: "smtp.example.com" })).toBeNull();
  });
});

describe("sendSmtpMail", () => {
  it("completes the SMTP handshake and dot-stuffs body lines", async () => {
    const server = await startMockSmtpServer();
    try {
      await sendSmtpMail(smtpConfig(server.port), {
        to: "user@example.com",
        subject: "Reset your password",
        text: "hello\r\n\r\n.start\r\nend",
      }, { allowInsecurePlain: true });

      const transcript = server.transcript();
      const auth = Buffer.from("\0smtp-user\0smtp-pass", "utf8").toString("base64");
      const ordered = [
        "EHLO ",
        `AUTH PLAIN ${auth}`,
        "MAIL FROM:<reset@example.com>",
        "RCPT TO:<user@example.com>",
        "DATA\r\n",
        "QUIT\r\n",
      ];
      let previous = -1;
      for (const token of ordered) {
        const index = transcript.indexOf(token);
        expect(index, token).toBeGreaterThan(previous);
        previous = index;
      }
      expect(transcript).toContain("Subject: Reset your password\r\n");
      expect(transcript).toContain("\r\n..start\r\n");
      expect(transcript).toContain("\r\n.\r\nQUIT\r\n");
    } finally {
      await server.close();
    }
  });

  it("rejects CRLF or NUL header injection before opening a socket", async () => {
    const server = await startMockSmtpServer();
    try {
      const base = smtpConfig(server.port);
      await expect(sendSmtpMail(base, {
        to: "user@example.com\r\nRCPT TO:<evil@example.com>",
        subject: "Reset",
        text: "body",
      }, { allowInsecurePlain: true })).rejects.toThrow(/to header/i);
      await expect(sendSmtpMail({ ...base, from: "reset@example.com\0" }, {
        to: "user@example.com",
        subject: "Reset",
        text: "body",
      }, { allowInsecurePlain: true })).rejects.toThrow(/from header/i);
      await expect(sendSmtpMail(base, {
        to: "user@example.com",
        subject: "Reset\nBcc: evil@example.com",
        text: "body",
      }, { allowInsecurePlain: true })).rejects.toThrow(/subject header/i);
      expect(server.connections()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("fails closed on a 5xx AUTH response without leaking credentials", async () => {
    const server = await startMockSmtpServer({ authResponse: "535 5.7.8 authentication failed\r\n" });
    try {
      const error = await sendSmtpMail(smtpConfig(server.port), {
        to: "user@example.com",
        subject: "Reset",
        text: "body",
      }, { allowInsecurePlain: true }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      const rendered = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      expect(rendered).toContain("535");
      expect(rendered).not.toContain("smtp-pass");
      expect(rendered).not.toContain("smtp-user");
    } finally {
      await server.close();
    }
  });

  it("fails closed before AUTH when EHLO does not advertise the AUTH capability", async () => {
    const server = await startMockSmtpServer({ ehloResponse: "250-localhost\r\n250 OK\r\n" });
    try {
      const error = await sendSmtpMail(smtpConfig(server.port), {
        to: "user@example.com",
        subject: "Reset",
        text: "body",
      }, { allowInsecurePlain: true }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("SMTP server did not advertise AUTH capability");
      expect((error as Error).message).not.toContain("smtp-pass");
      expect(server.transcript()).not.toContain("AUTH PLAIN");
    } finally {
      await server.close();
    }
  });

  it("recognizes case-insensitive AUTH capability spellings in multiline EHLO replies", async () => {
    const replies = [
      "250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n",
      "250-localhost\r\n250 auth plain\r\n",
      "250-localhost\r\n250-AUTH=PLAIN\r\n250 OK\r\n",
    ];
    for (const ehloResponse of replies) {
      const server = await startMockSmtpServer({ ehloResponse });
      try {
        await sendSmtpMail(smtpConfig(server.port), {
          to: "user@example.com",
          subject: "Reset",
          text: "body",
        }, { allowInsecurePlain: true });
        expect(server.transcript()).toContain("AUTH PLAIN");
      } finally {
        await server.close();
      }
    }
  });

  it("omits TLS SNI for IP-literal hosts and keeps it for DNS hostnames", () => {
    expect(resolveSmtpTlsServername("127.0.0.1")).toBeUndefined();
    expect(resolveSmtpTlsServername("::1")).toBeUndefined();
    expect(resolveSmtpTlsServername("[2001:db8::1]")).toBeUndefined();
    expect(resolveSmtpTlsServername("smtp.example.com")).toBe("smtp.example.com");
  });
});

describe("createPasswordResetSender SMTP integration", () => {
  it("uses PAPERWORK_SMTP delivery before the webhook fallback", async () => {
    const server = await startMockSmtpServer();
    const resetUrl = "https://paperwork.example.com/reset/raw-reset-token";
    try {
      vi.stubEnv("PAPERWORK_SMTP_HOST", "127.0.0.1");
      vi.stubEnv("PAPERWORK_SMTP_PORT", String(server.port));
      vi.stubEnv("PAPERWORK_SMTP_SECURE", "false");
      vi.stubEnv("PAPERWORK_SMTP_USER", "smtp-user");
      vi.stubEnv("PAPERWORK_SMTP_PASS", "smtp-pass");
      vi.stubEnv("PAPERWORK_SMTP_FROM", "reset@example.com");
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const warnings: unknown[] = [];
      const sendResetPassword = createPasswordResetSender({
        webhookUrl: "https://webhook.example.com/reset",
        fetchImpl,
        logger: { warn: (...args) => warnings.push(args) },
        smtpOptions: { allowInsecurePlain: true },
      });

      await sendResetPassword({
        user: { email: "user@example.com" },
        url: resetUrl,
        token: "raw-reset-token",
      });

      const transcript = server.transcript();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(0);
      expect(transcript).toContain("RCPT TO:<user@example.com>");
      expect(transcript).toContain("Subject: Reset your Paperwork password\r\n");
      expect(transcript).toContain(resetUrl);
      expect(transcript).toContain("This link expires in 1 hour.");
    } finally {
      vi.unstubAllEnvs();
      await server.close();
    }
  });
});
