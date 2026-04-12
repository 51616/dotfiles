import process from "node:process";

const mode = process.env.PI_SSH_FAKE_MODE ?? "normal";
let buffer = "";
let active = null;

function write(text) {
  process.stdout.write(text);
}

function handleCommand(line) {
  const startMatch = line.match(/__PI_SSH_BEGIN_[A-Za-z0-9_]+__/);
  const endMatch = line.match(/__PI_SSH_DONE_[A-Za-z0-9_]+__/);
  if (!startMatch || !endMatch) {
    return;
  }

  const startMarker = startMatch[0];
  const endMarker = endMatch[0];

  if (mode === "abort-no-marker") {
    active = { startMarker, endMarker };
    write(`\n${startMarker}\nworking\n`);
    return;
  }

  write(`\n${startMarker}\nhello from fake shell\n${endMarker}:0\n`);
}

process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf-8");

  if (text.includes("\u0003") && active) {
    write("^C\n");
    active = null;
    return;
  }

  buffer += text;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    handleCommand(line);
  }
});
