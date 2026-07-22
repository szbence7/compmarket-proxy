import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET;
const BASE = "https://compmarket.hu/xml";

// 10 perc – a teljes terméklista (type=all) simán 2-5 percig tart
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

app.get("/health", (_, res) => res.send("ok"));

app.get("/cm/:file", async (req, res) => {
  if (req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  const url = `${BASE}/${req.params.file}?${new URLSearchParams(req.query).toString()}`;

  // Ha a Lovable oldal lezárja a kapcsolatot, szakítsuk meg az upstream fetch-et is
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
  req.on("close", () => ac.abort(new Error("client closed")));

  // A Node/Express default socket timeout ne vágja el a hosszú letöltést
  req.setTimeout(UPSTREAM_TIMEOUT_MS + 30_000);
  res.setTimeout(UPSTREAM_TIMEOUT_MS + 30_000);

  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "tintakod-proxy/1.0",
        Accept: "application/xml, text/xml, */*",
        "Accept-Encoding": "gzip, deflate",
      },
    });

    // Fejlécek átvitele (a hop-by-hop és tömörítéssel kapcsolatosakat kihagyjuk,
    // mert az undici már kicsomagolta a body-t)
    res.status(r.status);
    const ct = r.headers.get("content-type") || "application/xml; charset=utf-8";
    res.setHeader("Content-Type", ct);
    const cl = r.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    if (!r.body) {
      res.end();
      return;
    }

    // STREAM: nem pufferoljuk memóriában a >50 MB-os XML-t,
    // hanem darabonként toljuk tovább a kliensnek.
    const reader = r.body.getReader();
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (!res.write(Buffer.from(value))) {
        // backpressure – várjuk meg amíg a socket lecsapolódik
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
    console.log(`[cm] ${req.params.file} ${r.status} ${bytes} bytes`);
  } catch (e) {
    console.error(`[cm] ${req.params.file} FAIL:`, e?.message || e);
    if (!res.headersSent) {
      res.status(502).send(`Proxy error: ${e?.message || e}`);
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timeoutId);
  }
});

app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
