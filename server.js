import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET; // megosztott jelszó a Lovable-lel
const BASE = "https://compmarket.hu/xml";

app.get("/health", (_, res) => res.send("ok"));

// A Lovable ide fog hívni: /cm/kategorialista.php?pid=xxx&authcode=yyy
app.get("/cm/:file", async (req, res) => {
  // egyszerű védelem, hogy más ne használja a proxydat
  if (req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  const url = `${BASE}/${req.params.file}?${new URLSearchParams(req.query).toString()}`;
  try {
    const r = await fetch(url);
    const body = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "text/xml").send(body);
  } catch (e) {
    res.status(500).send(`Proxy error: ${e.message}`);
  }
});

app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
