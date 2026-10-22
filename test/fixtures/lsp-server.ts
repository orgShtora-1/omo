// Deterministic protocol peer; no dependency on a provider or installed server.
let buffer = Buffer.alloc(0);
let document: { uri: string; text: string; version: number };
function send(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function receive(message: any) {
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize": reply({ capabilities: { positionEncoding: "utf-16", textDocumentSync: 1, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true, renameProvider: { prepareProvider: true } } }); break;
    case "workspace/symbol": reply([{ name: "fixture", kind: 13 }]); break;
    case "textDocument/documentSymbol": reply([{ name: "fixture", kind: 13 }]); break;
    case "textDocument/prepareRename": reply({ range: { start: message.params.position, end: { line: 0, character: document.text.length } }, placeholder: "abc" }); break;
    case "textDocument/rename": reply({ changes: { [document.uri.replace(/^file:\/\/\/([A-Z]):/, (_, drive) => `file:///${drive.toLowerCase()}:`)]: [{ range: { start: message.params.position, end: { line: 0, character: document.text.length } }, newText: message.params.newName }] } }); break;
    case "textDocument/didOpen":
      document = message.params.textDocument;
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, version: document.version, diagnostics: [{ message: "fixture diagnostic", range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } } }] } }); break;
    case "textDocument/didChange":
      document = { ...document, version: message.params.textDocument.version, text: message.params.contentChanges[0].text };
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, version: document.version, diagnostics: [] } }); break;
    case "textDocument/definition":
    case "textDocument/references": reply([{ uri: document.uri, range: { start: message.params.position, end: { line: 0, character: document.text.length } } }]); break;
    case "fixture/crash": process.exit(7); break;
    case "fixture/hang": break;
    case "shutdown": reply(null); break;
    case "exit": process.exit(0); break;
  }
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length);
    buffer = buffer.subarray(end + 4 + length);
    receive(JSON.parse(body.toString()));
  }
});
