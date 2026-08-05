"use strict";

const http = require("node:http");
const net = require("node:net");
const { connectViaExit } = require("./upstream");

/**
 * Local HTTP proxy with CONNECT support (browsers / system proxy).
 */
function createHttpProxyServer({ host, port, getExit, meter, onLog, killSwitch }) {
  const log = onLog || (() => {});
  // Passthrough guard if none provided (backwards compat)
  const guard = killSwitch || { guard: () => ({ allowed: true }), stats: () => ({ blocked_connections: 0 }) };

  const ks403 = (res, reason) => {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end(`Forbidden: ${reason}`);
  };

  const server = http.createServer((req, res) => {
    // plain HTTP proxy
    meter && meter.openConn();
    const cleanup = () => meter && meter.closeConn();
    try {
      const u = new URL(req.url);
      const exit = typeof getExit === "function" ? getExit() : null;

      // --- Kill-switch guard for plain HTTP ---
      const ks = guard.guard(exit, u.hostname, Number(u.port || 80));
      if (!ks.allowed) {
        log(`http kill-switch block ${u.hostname}:${u.port || 80} — ${ks.reason}`);
        ks403(res, ks.reason);
        cleanup();
        return;
      }

      connectViaExit(exit, u.hostname, Number(u.port || 80))
        .then((remote) => {
          const headers = { ...req.headers, host: u.host };
          delete headers["proxy-connection"];
          const preamble =
            `${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n` +
            Object.entries(headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n") +
            "\r\n\r\n";
          remote.write(preamble);
          req.on("data", (c) => {
            meter && meter.record("out", c.length);
            remote.write(c);
          });
          remote.on("data", (c) => {
            meter && meter.record("in", c.length);
            res.socket.write(c);
          });
          req.on("end", () => remote.end());
          remote.on("end", () => {
            res.socket.end();
            cleanup();
          });
          remote.on("error", () => {
            res.destroy();
            cleanup();
          });
          req.on("error", () => {
            remote.destroy();
            cleanup();
          });
        })
        .catch((err) => {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`Bad gateway: ${err.message}`);
          cleanup();
        });
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(String(err.message));
      cleanup();
    }
  });

  server.on("connect", (req, clientSocket, head) => {
    meter && meter.openConn();
    const cleanup = () => {
      meter && meter.closeConn();
      try {
        clientSocket.destroy();
      } catch {
        /* ignore */
      }
    };
    const [hostName, portStr] = String(req.url || "").split(":");
    const targetPort = Number(portStr || 443);
    const exit = typeof getExit === "function" ? getExit() : null;

    // --- Kill-switch guard for CONNECT ---
    const ks = guard.guard(exit, hostName, targetPort);
    if (!ks.allowed) {
      log(`http-connect kill-switch block ${hostName}:${targetPort} — ${ks.reason}`);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n" +
        `Kill switch: ${ks.reason}\r\n`);
      cleanup();
      return;
    }

    connectViaExit(exit, hostName, targetPort)
      .then((remote) => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) {
          meter && meter.record("out", head.length);
          remote.write(head);
        }
        clientSocket.on("data", (c) => {
          meter && meter.record("out", c.length);
          remote.write(c);
        });
        remote.on("data", (c) => {
          meter && meter.record("in", c.length);
          clientSocket.write(c);
        });
        clientSocket.on("error", cleanup);
        remote.on("error", cleanup);
        clientSocket.on("close", () => {
          remote.destroy();
          cleanup();
        });
        remote.on("close", () => {
          clientSocket.destroy();
          cleanup();
        });
        log(`http-connect ok ${hostName}:${targetPort} via ${(exit && exit.id) || "direct"}`);
      })
      .catch((err) => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        log(`http-connect fail ${err.message}`);
        cleanup();
      });
  });

  // keep linter happy - net used for type identity
  void net;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { createHttpProxyServer };
