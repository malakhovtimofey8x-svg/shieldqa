exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const body = JSON.parse(event.body || "{}");

  // ── ROUTE 1: Real site fetch ──────────────────────────────────────────
  // Called with { action: "fetch", url: "https://..." }
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
    };

    try {
      const start = Date.now();
      const res = await fetch(targetUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ShieldQA/1.0; +https://shieldqa.netlify.app)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        // 10 second timeout via signal
        signal: AbortSignal.timeout(10000),
      });

      result.responseTime = Date.now() - start;
      result.status = res.status;
      result.redirected = res.redirected;
      result.finalUrl = res.url;

      // Capture all response headers
      res.headers.forEach((value, key) => {
        result.headers[key.toLowerCase()] = value;
      });

      // Get HTML — cap at 80KB to stay within limits
      const text = await res.text();
      result.html = text.slice(0, 80000);
      result.htmlLength = text.length;

    } catch (err) {
      result.error = err.message;
      result.status = 0;
    }

    // Also probe /robots.txt and /sitemap.xml
    try {
      const base = new URL(targetUrl).origin;
      const [robotsRes, sitemapRes] = await Promise.allSettled([
        fetch(base + "/robots.txt", { signal: AbortSignal.timeout(5000) }),
        fetch(base + "/sitemap.xml", { signal: AbortSignal.timeout(5000) }),
      ]);
      result.robotsTxt = robotsRes.status === "fulfilled" && robotsRes.value.status === 200;
      result.sitemapXml = sitemapRes.status === "fulfilled" && sitemapRes.value.status === 200;

      if (result.robotsTxt) {
        const rt = await robotsRes.value.text();
        result.robotsTxtContent = rt.slice(0, 2000);
      }
    } catch {
      result.robotsTxt = false;
      result.sitemapXml = false;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Proxy failed", details: err.message }),
    };
  }
};
