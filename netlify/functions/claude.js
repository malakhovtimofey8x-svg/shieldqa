exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  // ── ROUTE 1: Real site fetch ──────────────────────────────────────────
  if (body.action === "fetch") {
    const targetUrl = body.url;
    if (!targetUrl) {
      return { statusCode: 400, body: JSON.stringify({ error: "No URL provided" }) };
    }

    const result = {
      url: targetUrl,
      status: null,
      redirected: false,
      finalUrl: targetUrl,
      responseTime: null,
      headers: {},
      html: "",
      htmlLength: 0,
      error: null,
      robotsTxt: false,
      sitemapXml: false,
    };

    // Fetch with manual timeout (compatible with all Node versions)
    const fetchWithTimeout = (url, options = {}, timeoutMs = 10000) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
        fetch(url, options)
          .then(res => { clearTimeout(timer); resolve(res); })
          .catch(err => { clearTimeout(timer); reject(err); });
      });
    };

    try {
      const start = Date.now();
      const res = await fetchWithTimeout(targetUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ShieldQA/1.0; +https://sheildqa.netlify.app)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Cache-Control": "no-cache",
        },
      }, 12000);

      result.responseTime = Date.now() - start;
      result.status = res.status;
      result.redirected = res.redirected;
      result.finalUrl = res.url;

      res.headers.forEach((value, key) => {
        result.headers[key.toLowerCase()] = value;
      });

      const text = await res.text();
      result.html = text.slice(0, 80000);
      result.htmlLength = text.length;

    } catch (err) {
      result.error = err.message;
      result.status = 0;
    }

    // Probe robots.txt and sitemap.xml
    try {
      const base = new URL(targetUrl).origin;
      const fetchWithTimeout2 = (url, ms) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("timeout")), ms);
        fetch(url).then(r => { clearTimeout(t); res(r); }).catch(e => { clearTimeout(t); rej(e); });
      });

      const [robotsRes, sitemapRes] = await Promise.allSettled([
        fetchWithTimeout2(base + "/robots.txt", 5000),
        fetchWithTimeout2(base + "/sitemap.xml", 5000),
      ]);

      result.robotsTxt = robotsRes.status === "fulfilled" && robotsRes.value.status === 200;
      result.sitemapXml = sitemapRes.status === "fulfilled" && sitemapRes.value.status === 200;

      if (result.robotsTxt) {
        try {
          const rt = await robotsRes.value.text();
          result.robotsTxtContent = rt.slice(0, 2000);
        } catch {}
      }
    } catch {
      result.robotsTxt = false;
      result.sitemapXml = false;
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify(result),
    };
  }

  // ── ROUTE 2: Claude API proxy ─────────────────────────────────────────
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: event.body,
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Proxy failed", details: err.message }),
    };
  }
};
