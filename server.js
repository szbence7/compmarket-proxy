import express from "express";
import { Agent, fetch } from "undici";

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET;
const BASE = "https://compmarket.hu/xml";

// 15 perc – a teljes terméklista (type=all) összeállítása a CompMarketnél 5 percnél is tovább tarthat
const UPSTREAM_TIMEOUT_MS = 15 * 60 * 1000;

// A Node beépített fetch-e 5 perc után feladja, ha nem jön válaszfejléc („fetch failed”) – ezt emeljük meg.
const upstream = new Agent({
  connectTimeout: 30_000,
  headersTimeout: UPSTREAM_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_TIMEOUT_MS,
});

app.get("/health", (_, res) => res.send("ok"));

app.get("/cm/:file", async (req, res) => {
  if (req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  const url = `${BASE}/${req.params.file}?${new URLSearchParams(req.query).toString()}`;
  const started = Date.now();

  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
  // Csak akkor szakítunk, ha a hívó tényleg bontotta a kapcsolatot (a válasz még nem ment ki teljesen).
  res.on("close", () => {
    if (!res.writableFinished) ac.abort(new Error("client closed"));
  });

  req.setTimeout(UPSTREAM_TIMEOUT_MS + 30_000);
  res.setTimeout(UPSTREAM_TIMEOUT_MS + 30_000);

  try {
    const r = await fetch(url, {
      dispatcher: upstream,
      signal: ac.signal,
      headers: {
        "User-Agent": "tintakod-proxy/1.0",
        Accept: "application/xml, text/xml, */*",
        "Accept-Encoding": "gzip, deflate",
      },
    });

    res.status(r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/xml; charset=utf-8");
    // Content-Length szándékosan nincs: a fetch kicsomagolja a gzip-et, így az eredeti hossz nem stimmelne.

    if (!r.body) {
      res.end();
      return;
    }

    const reader = r.body.getReader();
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
    console.log(`[cm] ${req.params.file} ${r.status} ${bytes} bytes ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    // A „fetch failed” mögötti valódi ok (pl. UND_ERR_HEADERS_TIMEOUT, ECONNRESET) a cause-ban van.
    const cause = e?.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : "";
    const msg = `${e?.message || e}${cause}`;
    console.error(`[cm] ${req.params.file} FAIL after ${Math.round((Date.now() - started) / 1000)}s:`, msg);
    if (!res.headersSent) {
      res.status(502).send(`Proxy error: ${msg}`);
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timeoutId);
  }
});

app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
