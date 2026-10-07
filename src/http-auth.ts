import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Remote binds require a token; browser clients exchange it for an HttpOnly cookie. */
export function createAccessGuard(host: string, token = process.env.ASHUB_TOKEN): {
  token: string | undefined;
  allow(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
} {
  const local = host === "localhost" || host === "::1" || /^127\./.test(host);
  const secret = token || (local ? undefined : randomBytes(32).toString("hex"));
  return {
    token: secret,
    async allow(req, res) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
        res.writeHead(403); res.end("foreign origin"); return false;
      }
      if (!secret) return true;
      res.setHeader("Cache-Control", "no-store");
      if (req.url === "/auth" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>asHub login</title><body><h1>asHub</h1><form method="post" action="/auth"><label>Access token <input name="token" type="password" required autocomplete="current-password"></label><button>Sign in</button></form></body></html>');
        return false;
      }
      if (req.url === "/auth" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 8192) { res.writeHead(413); res.end(); return false; }
        }
        if (equal(new URLSearchParams(body).get("token") ?? "", secret)) {
          res.writeHead(303, { Location: "/", "Set-Cookie": `ashub_token=${encodeURIComponent(secret)}; HttpOnly; SameSite=Strict; Path=/` });
        } else res.writeHead(401);
        res.end(); return false;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const encodedCookie = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("ashub_token="))?.slice(12) ?? "";
      let cookie = "";
      try { cookie = decodeURIComponent(encodedCookie); } catch {}
      if (equal(bearer, secret) || equal(cookie, secret)) return true;
      if (req.method === "GET" && req.headers.accept?.includes("text/html")) res.writeHead(303, { Location: "/auth" });
      else res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "authentication required" }));
      return false;
    },
  };
}
