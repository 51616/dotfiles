import { stdin, stdout } from "node:process";

const mode = process.argv[2] ?? "echo";
const PROTOCOL_VERSION = 1;
let input = Buffer.alloc(0);
let heldRequest = null;

function encodeFrame(header, payload = Buffer.alloc(0)) {
  const completeHeader = { ...header, payloadLength: payload.length };
  const headerBytes = Buffer.from(JSON.stringify(completeHeader), "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(headerBytes.length, 0);
  return Buffer.concat([prefix, headerBytes, payload]);
}

function send(header, payload = Buffer.alloc(0)) {
  stdout.write(encodeFrame(header, payload));
}

function responseFrame(request, payload = request.payload) {
  return encodeFrame(
    {
      version: PROTOCOL_VERSION,
      kind: "response",
      id: request.header.id,
      ok: true,
      token: request.header.token ?? null,
    },
    payload,
  );
}

function sendResponse(request, payload = request.payload) {
  const frame = responseFrame(request, payload);
  if (mode !== "fragmented-response") {
    stdout.write(frame);
    return;
  }
  let offset = 0;
  const writeNext = () => {
    if (offset >= frame.length) return;
    const end = Math.min(offset + 4_096, frame.length);
    stdout.write(frame.subarray(offset, end));
    offset = end;
    setImmediate(writeNext);
  };
  writeNext();
}

function handleRequest(request) {
  if (mode === "exit-after-request") {
    process.exit(17);
  }
  if (mode === "malformed-after-request") {
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(0xffffffff, 0);
    stdout.write(prefix);
    return;
  }
  if (mode === "out-of-order") {
    if (!heldRequest) {
      heldRequest = request;
      return;
    }
    sendResponse(request);
    sendResponse(heldRequest);
    heldRequest = null;
    return;
  }
  if (mode === "duplicate-response") {
    sendResponse(request);
    sendResponse(request);
    return;
  }
  const delayMs = Number(request.header.delayMs ?? 0);
  setTimeout(() => sendResponse(request), Math.max(0, delayMs));
}

function parseFrames() {
  while (input.length >= 4) {
    const headerLength = input.readUInt32BE(0);
    if (input.length < 4 + headerLength) return;
    const header = JSON.parse(input.subarray(4, 4 + headerLength).toString("utf8"));
    const payloadLength = Number(header.payloadLength ?? 0);
    if (input.length < 4 + headerLength + payloadLength) return;
    const payload = Buffer.from(input.subarray(4 + headerLength, 4 + headerLength + payloadLength));
    input = input.subarray(4 + headerLength + payloadLength);
    handleRequest({ header, payload });
  }
}

stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  parseFrames();
});

stdin.on("end", () => process.exit(0));

if (mode === "startup-error") {
  process.stderr.write("python3 or python is required for pi-ssh file operations\n");
  process.exit(127);
} else if (mode === "silent-handshake") {
  setInterval(() => {}, 1_000);
} else if (mode === "startup-stderr-flood") {
  process.stderr.write(`flood-start-${"x".repeat(2 * 1024 * 1024)}-flood-tail`);
  setInterval(() => {}, 1_000);
} else {
  send({
    version: mode === "bad-version" ? 999 : PROTOCOL_VERSION,
    kind: "hello",
    id: 0,
    ok: true,
    capabilities: mode === "missing-capability"
      ? ["read_file", "read_workspace", "write_file"]
      : ["edit_workspace", "read_file", "read_workspace", "write_file"],
  });
  if (mode === "unsolicited-response") {
    send({ version: PROTOCOL_VERSION, kind: "response", id: 999, ok: true });
  }
  if (mode === "close-stdin") {
    stdin.destroy();
    setInterval(() => {}, 1_000);
  }
  if (mode === "slow-consume") {
    stdin.pause();
    setTimeout(() => stdin.resume(), 250);
  }
}
