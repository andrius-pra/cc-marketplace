#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { argv, stdin, stdout, stderr, exit, env } from "node:process";

const logPath = env.TYPESCRIPT_LSP_LOG_FILE;
const logStream = createWriteStream(logPath, { flags: "a" });

function log(direction, message) {
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

function createMessageParser(direction, forward, { transform } = {}) {
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

// --- Spawn the real language server ---

// Pass through all args except the script name itself
const args = argv.slice(2);
const tsLspPath = new URL("./node_modules/typescript-language-server/lib/cli.mjs", import.meta.url).pathname.replace(/^\//, "");
const child = spawn(process.execPath, [tsLspPath, ...args], {
  stdio: ["pipe", "pipe", "pipe"],
});

// client → server
const parseFromClient = createMessageParser("client→server", (data) => {
  child.stdin.write(data);
}, { transform: normalizeUris });

stdin.on("data", parseFromClient);
stdin.on("end", () => {
  child.stdin.end();
});

// server → client
const parseFromServer = createMessageParser("server→client", (data) => {
  stdout.write(data);
});

child.stdout.on("data", parseFromServer);

// stderr pass-through
child.stderr.pipe(stderr);

// --- Lifecycle ---

child.on("exit", (code, signal) => {
  logStream.end(() => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      exit(code ?? 1);
    }
  });
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
