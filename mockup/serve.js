// Server minimo per guardare il mockup: node mockup/serve.js  →  http://localhost:3210
const http = require('http'), fs = require('fs'), path = require('path');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer((req, res) => {
  const name = req.url.split('?')[0] === '/' ? 'nyc.html' : path.basename(req.url.split('?')[0]);
  const type = TYPES[path.extname(name)];
  fs.readFile(path.join(__dirname, name), (err, buf) => {
    if (err || !type) { res.writeHead(404); return res.end('Non trovato'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(3210, () => console.log('Mockup su http://localhost:3210'));
