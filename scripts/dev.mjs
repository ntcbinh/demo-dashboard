#!/usr/bin/env node
/**
 * Runs the sensor WebSocket feed and the Next.js dev server together.
 *
 * Written by hand rather than pulling in `concurrently`: it is ~60 lines, and
 * it lets the two processes share a lifecycle properly - if either one exits,
 * the other is torn down, so there is never an orphaned simulator left holding
 * port 3101 after Ctrl-C.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const RESET = "\u001b[0m";

const targets = [
  { name: "ws  ", color: "\u001b[36m", command: process.execPath, args: ["server/ws-server.ts"] },
  { name: "next", color: "\u001b[35m", command: "npx", args: ["next", "dev"] },
];

const children = [];
let shuttingDown = false;

function write(target, line) {
  process.stdout.write(`${target.color}[${target.name}]${RESET} ${line}\n`);
}

function relay(target, chunk) {
  const lines = chunk.toString().split("\n");
  // Drop the empty trailing element so a trailing newline does not print a
  // bare prefix with no content.
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) write(target, line);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  // Give the children a moment to exit cleanly before the runner leaves.
  setTimeout(() => process.exit(code), 300);
}

for (const target of targets) {
  const child = spawn(target.command, target.args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout.on("data", (chunk) => relay(target, chunk));
  child.stderr.on("data", (chunk) => relay(target, chunk));

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    write(target, `exited (${signal !== null ? `signal ${signal}` : `code ${code}`})`);
    shutdown(code ?? 1);
  });

  child.on("error", (error) => {
    write(target, `failed to start: ${error.message}`);
    shutdown(1);
  });

  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}
