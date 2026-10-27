const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'dist');
const contentTypes = new Map([
    ['.geojson', 'application/geo+json; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8']
]);

http.createServer((request, response) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
        response.writeHead(400).end('Invalid URL');
        return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
    }

    fs.stat(filePath, (error, stats) => {
        if (error || !stats.isFile()) {
            response.writeHead(404).end('Not found');
            return;
        }

        response.setHeader(
            'Content-Type',
            contentTypes.get(path.extname(filePath)) || 'application/octet-stream'
        );
        fs.createReadStream(filePath).pipe(response);
    });
}).listen(4173, () => {
    console.log('Preview: http://localhost:4173');
});
