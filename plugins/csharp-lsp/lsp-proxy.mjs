#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { argv, stdin, stdout, stderr, exit, env } from "node:process";

const debug = !!env.DEBUG;
const logStream = debug
  ? createWriteStream(env.LSP_LOG_FILE || "lsp-log.jsonl", { flags: "a" })
  : null;

function log(direction, message) {
  if (!logStream) return;
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    direction,
    message,
  });
  logStream.write(entry + "\n");
}

// --- URI normalization (client→server only) ---

function normalizeFileUri(uri) {
  // Match file:// or file:/// URIs
  if (!uri.startsWith("file://")) return uri;

  // Strip the file:// or file:/// prefix to get the raw path
  let path = uri.replace(/^file:\/{2,3}/, "");

  // Backslashes → forward slashes
  path = path.replace(/\\/g, "/");

  // Remove trailing slash on file paths (but keep root "/" alone)
  if (path.length > 1) path = path.replace(/\/+$/, "");

  return "file:///" + path;
}

function normalizeUris(obj) {
  if (typeof obj === "string") {
    return obj.startsWith("file://") ? normalizeFileUri(obj) : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeUris);
  }
  if (obj !== null && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = normalizeUris(v);
    }
    return out;
  }
  return obj;
}

// --- LSP message parser ---

function createMessageParser(direction, forward, { transform, intercept } = {}) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      // Look for header/body separator
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep === -1) break;

      // Parse Content-Length from headers
      const headerText = buffer.subarray(0, sep).toString("ascii");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed — forward everything up to and including separator, move on
        const raw = buffer.subarray(0, sep + 4);
        forward(raw);
        buffer = buffer.subarray(sep + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = sep + 4;
      const messageEnd = bodyStart + contentLength;

      if (buffer.length < messageEnd) break; // need more data

      const body = buffer.subarray(bodyStart, messageEnd);

      try {
        let parsed = JSON.parse(body.toString("utf-8"));
        if (transform) parsed = transform(parsed);
        log(direction, parsed);

        // Allow intercept to handle the message (e.g. respond directly to server)
        if (intercept && intercept(parsed)) {
          buffer = buffer.subarray(messageEnd);
          continue;
        }

        // Re-serialize with new Content-Length (transform may change size)
        const newBody = Buffer.from(JSON.stringify(parsed), "utf-8");
        const frame = Buffer.from(`Content-Length: ${newBody.length}\r\n\r\n`);
        forward(Buffer.concat([frame, newBody]));
      } catch {
        // Unparseable — forward original raw frame as-is
        const raw = buffer.subarray(0, messageEnd);
        log(direction, { _raw: body.toString("utf-8") });
        forward(raw);
      }

      buffer = buffer.subarray(messageEnd);
    }
  };
}

// --- Server→client method interception ---
// csharp-ls sends requests that Claude Code's LSP client doesn't handle.
// Respond with null directly back to the server instead of forwarding.

const INTERCEPTED_METHODS = new Set([
  "client/registerCapability",
  "window/workDoneProgress/create",
  "window/workDoneProgress/cancel",
]);

function sendToServer(message) {
  const body = Buffer.from(JSON.stringify(message), "utf-8");
  const frame = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(Buffer.concat([frame, body]));
}

// --- Spawn the real language server ---

// Pass through all args except the script name itself
const args = argv.slice(2);
const child = spawn("csharp-ls", args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});

// client → server
const parseFromClient = createMessageParser("client→server", (data) => {
  child.stdin.write(data);
}, { transform: normalizeUris });

stdin.on("data", parseFromClient);
stdin.on("end", () => {
  child.stdin.end();
});

// server → client (with interception of unsupported methods)
const parseFromServer = createMessageParser("server→client", (data) => {
  stdout.write(data);
}, {
  intercept(msg) {
    if (msg.id !== undefined && INTERCEPTED_METHODS.has(msg.method)) {
      log("proxy→server", { id: msg.id, intercepted: msg.method });
      sendToServer({ jsonrpc: "2.0", id: msg.id, result: null });
      return true;
    }
    return false;
  },
});

child.stdout.on("data", parseFromServer);

// stderr pass-through
child.stderr.pipe(stderr);

// --- Lifecycle ---

child.on("exit", (code, signal) => {
  const done = () => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      exit(code ?? 1);
    }
  };
  if (logStream) logStream.end(done);
  else done();
});

child.on("error", (err) => {
  stderr.write(`lsp-proxy: failed to start child: ${err.message}\n`);
  exit(1);
});

// Forward termination signals to child
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

// Handle broken pipes gracefully
stdin.on("error", () => child.kill());
stdout.on("error", () => child.kill());
