// A tiny Docker Engine API client over the unix socket (no dependencies).
import { request } from "node:http";

export class DockerError extends Error {
  constructor(status, message, path) {
    super(`docker ${path}: ${status} ${message}`);
    this.status = status;
  }
}

export function dockerClient(socketPath, { version = "v1.43", timeoutMs = 60_000 } = {}) {
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        { socketPath, method, path: `/${version}${path}`, headers: { "content-type": "application/json", ...(data ? { "content-length": data.length } : {}) }, timeout: timeoutMs },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {}
            if (res.statusCode >= 400) return reject(new DockerError(res.statusCode, json?.message ?? text.slice(0, 300), path));
            resolve({ status: res.statusCode, body: json ?? text });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`docker ${path}: timeout`)));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  return {
    call,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    // 404 → null instead of an error.
    inspect: (p) => call("GET", p).then((r) => r.body, (e) => (e.status === 404 ? null : Promise.reject(e))),
  };
}
