// Puts the mock server back in its start state before a flow.
const res = http.get('http://localhost:8787/e2e/control?reset=1');
if (res.status !== 200) throw new Error('mock server is not running on :8787 (node tools/mock-server.js)');
