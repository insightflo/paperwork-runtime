import net from "node:net";
import tls from "node:tls";
export type SmtpConfig = { host: string; port: number; secure?: boolean; user?: string; pass?: string; from: string };
export type SmtpMessage = { to: string; subject: string; text: string };
export type SendSmtpMailOptions = { timeoutMs?: number; allowInsecurePlain?: boolean; rejectUnauthorized?: boolean; servername?: string; tls?: Omit<tls.ConnectionOptions, "socket" | "host" | "port"> };
type EnvLike = Readonly<Record<string, string | undefined>>;
type SmtpReply = { code: number; lines: string[] };
type Waiter = { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void };
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_REPLY_BUFFER_BYTES = 64 * 1024;
export function readSmtpConfigFromEnv(env: EnvLike = process.env): SmtpConfig | null {
  const host = env.PAPERWORK_SMTP_HOST?.trim();
  const from = env.PAPERWORK_SMTP_FROM?.trim();
  if (!host || !from) return null;
  const secureValue = env.PAPERWORK_SMTP_SECURE?.trim().toLowerCase();
  const secure = secureValue === "true" || secureValue === "1";
  const rawPort = env.PAPERWORK_SMTP_PORT?.trim();
  const parsedPort = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  const port = parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : secure ? 465 : 587;
  const user = env.PAPERWORK_SMTP_USER;
  const pass = env.PAPERWORK_SMTP_PASS;
  return { host, port, secure, ...(user ? { user } : {}), ...(pass ? { pass } : {}), from };
}
class SmtpIo {
  private buffer = "";
  private currentLines: string[] = [];
  private replies: SmtpReply[] = [];
  private waiter: Waiter | null = null;
  private failure: Error | null = null;
  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.handleData).on("error", this.handleError).on("close", this.handleClose);
  }

  detach() {
    this.socket.off("data", this.handleData).off("error", this.handleError).off("close", this.handleClose);
  }

  write(value: string) {
    if (this.failure) throw this.failure;
    this.socket.write(value, "utf8");
  }

  readReply(): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.waiter) return Promise.reject(new Error("SMTP protocol reader conflict"));
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  private handleData = (chunk: Buffer) => {
    if (this.failure) return;
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > MAX_REPLY_BUFFER_BYTES) {
      this.fail(new Error("SMTP response exceeded the safety limit"));
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1 && !this.failure) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
  };

  private consumeLine(line: string) {
    const match = /^(\d{3})(-|\s|$)/.exec(line);
    if (!match) {
      this.fail(new Error("SMTP protocol error"));
      return;
    }
    this.currentLines.push(line);
    if (match[2] === "-") return;
    const reply = { code: Number(match[1]), lines: this.currentLines };
    this.currentLines = [];
    if (!this.waiter) {
      this.replies.push(reply);
      return;
    }
    const waiter = this.waiter;
    this.waiter = null;
    waiter.resolve(reply);
  }

  private handleError = (error: Error) => this.fail(error);
  private handleClose = () => {
    if (!this.failure) this.fail(new Error("SMTP connection closed"));
  };

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(error);
  }
}

function assertHeaderValue(name: "to" | "from" | "subject", value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error(`Invalid SMTP ${name} header`);
}

function envelopeAddress(value: string): string {
  return (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim();
}

function encodeSubject(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

export function resolveSmtpTlsServername(host: string, opts: Pick<SendSmtpMailOptions, "servername" | "tls"> = {}): string | undefined {
  const explicit = opts.tls?.servername ?? opts.servername;
  if (explicit !== undefined) return explicit;
  const normalized = host.trim().replace(/^\[|\]$/g, "");
  return net.isIP(normalized) === 0 ? host : undefined;
}

function tlsOptions(config: SmtpConfig, opts: SendSmtpMailOptions): tls.ConnectionOptions {
  const servername = resolveSmtpTlsServername(config.host, opts);
  return {
    ...opts.tls,
    ...(servername === undefined ? {} : { servername }),
    rejectUnauthorized: opts.tls?.rejectUnauthorized ?? opts.rejectUnauthorized ?? true,
  };
}

function waitForSocket(socket: net.Socket, event: "connect" | "secureConnect"): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off(event, onReady).off("error", onError); };
    const onReady = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    socket.once(event, onReady).once("error", onError);
  });
}

function assert2xx(reply: SmtpReply, context: string) {
  if (reply.code < 200 || reply.code >= 300) throw new Error(`SMTP ${context} failed with code ${reply.code}`);
}

async function read2xx(io: SmtpIo, context: string): Promise<SmtpReply> {
  const reply = await io.readReply();
  assert2xx(reply, context);
  return reply;
}

async function command(io: SmtpIo, line: string, context: string): Promise<SmtpReply> {
  io.write(`${line}\r\n`);
  return read2xx(io, context);
}

function advertisesCapability(reply: SmtpReply, capability: "AUTH" | "STARTTLS"): boolean {
  return reply.lines.some((line) => {
    const keyword = /^\d{3}[ -]([^\s]+)/.exec(line)?.[1];
    return keyword?.split("=", 1)[0].toUpperCase() === capability;
  });
}

function buildData(config: SmtpConfig, message: SmtpMessage): string {
  const text = message.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").join("\r\n");
  const headers = [
    `From: ${config.from}`, `To: ${message.to}`, `Subject: ${encodeSubject(message.subject)}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit",
  ];
  const payload = `${headers.join("\r\n")}\r\n\r\n${text}`.replace(/(^|\r\n)\./g, "$1..");
  return `${payload}${payload.endsWith("\r\n") ? "" : "\r\n"}.\r\n`;
}

export async function sendSmtpMail(config: SmtpConfig, message: SmtpMessage, opts: SendSmtpMailOptions = {}): Promise<void> {
  assertHeaderValue("to", message.to);
  assertHeaderValue("from", config.from);
  assertHeaderValue("subject", message.subject);
  const mailFrom = envelopeAddress(config.from);
  const rcptTo = envelopeAddress(message.to);
  if (!config.host.trim() || !mailFrom || !rcptTo || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("Invalid SMTP configuration");

  const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  let socket: net.Socket | undefined;
  let io: SmtpIo | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    socket?.destroy(new Error("SMTP operation timed out"));
  }, timeoutMs);
  timer.unref();

  try {
    const implicitTls = config.secure === true;
    socket = implicitTls
      ? tls.connect({ ...tlsOptions(config, opts), host: config.host, port: config.port })
      : net.connect({ host: config.host, port: config.port });
    await waitForSocket(socket, implicitTls ? "secureConnect" : "connect");
    io = new SmtpIo(socket);
    await read2xx(io, "greeting");
    let ehlo = await command(io, "EHLO paperwork.local", "EHLO");
    let encrypted = implicitTls;

    if (!encrypted && advertisesCapability(ehlo, "STARTTLS")) {
      await command(io, "STARTTLS", "STARTTLS");
      io.detach();
      socket = tls.connect({ ...tlsOptions(config, opts), socket });
      await waitForSocket(socket, "secureConnect");
      io = new SmtpIo(socket);
      encrypted = true;
      ehlo = await command(io, "EHLO paperwork.local", "EHLO");
    }
    if (!encrypted && !(opts.allowInsecurePlain === true && isLoopbackHost(config.host))) throw new Error("SMTP server does not offer STARTTLS");
    if (config.user && config.pass) {
      if (!advertisesCapability(ehlo, "AUTH")) throw new Error("SMTP server did not advertise AUTH capability");
      const credential = Buffer.from(`\0${config.user}\0${config.pass}`, "utf8").toString("base64");
      await command(io, `AUTH PLAIN ${credential}`, "AUTH PLAIN");
    }

    await command(io, `MAIL FROM:<${mailFrom}>`, "MAIL FROM");
    await command(io, `RCPT TO:<${rcptTo}>`, "RCPT TO");
    io.write("DATA\r\n");
    const dataStart = await io.readReply();
    if (dataStart.code !== 354) throw new Error(`SMTP DATA failed with code ${dataStart.code}`);
    io.write(buildData(config, message));
    await read2xx(io, "DATA");
    await command(io, "QUIT", "QUIT");
  } catch (error) {
    if (timedOut) throw new Error("SMTP operation timed out");
    if (error instanceof Error) throw error;
    throw new Error("SMTP delivery failed");
  } finally {
    clearTimeout(timer);
    io?.detach();
    socket?.destroy();
  }
}
