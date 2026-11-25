const http = require("http");
const fs = require("fs");
const path = require("path");

const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    const cleanUrl = (req.url || "/").split("?")[0];
    const filePath = path.join(
      __dirname,
      cleanUrl === "/" ? "index.html" : cleanUrl
    );

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("No encontrado");
      }
      res.writeHead(200, {
        "Content-Type": mime[path.extname(filePath)] || "application/octet-stream",
      });
      res.end(data);
    });
  })
  .listen(5500, () => {
    console.log("Frontend en http://localhost:5500");
  });