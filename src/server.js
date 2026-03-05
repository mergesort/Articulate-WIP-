import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const PORT = Number.parseInt(process.env.PORT ?? "10000", 10);
const MONOLITH_BIN = process.env.MONOLITH_BIN ?? "/usr/local/bin/monolith";
const DEFAULT_TIMEOUT_SEC = Number.parseInt(
  process.env.MONOLITH_TIMEOUT_SEC ?? "60",
  10
);
const MAX_TIMEOUT_SEC = Number.parseInt(
  process.env.MONOLITH_MAX_TIMEOUT_SEC ?? "180",
  10
);

const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION;
const S3_PREFIX = process.env.S3_PREFIX ?? "archives";
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_FORCE_PATH_STYLE_ENV = process.env.S3_FORCE_PATH_STYLE;
const S3_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN;
const S3_ACCESS_KEY_ID =
  process.env.SUPABASE_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY =
  process.env.SUPABASE_S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY;
const s3Enabled = Boolean(S3_BUCKET && S3_REGION);

function parseBool(input, fallback = false) {
  if (input === undefined || input === null || input === "") return fallback;
  if (typeof input === "boolean") return input;
  const normalized = String(input).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function inferForcePathStyle(endpoint, overrideValue) {
  const parsedOverride = parseBool(overrideValue, null);
  if (typeof parsedOverride === "boolean") return parsedOverride;
  if (!endpoint) return false;
  return endpoint.includes("/storage/v1/s3");
}

const s3Client = s3Enabled
  ? new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT || undefined,
      forcePathStyle: inferForcePathStyle(S3_ENDPOINT, S3_FORCE_PATH_STYLE_ENV),
      credentials: S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: S3_ACCESS_KEY_ID,
            secretAccessKey: S3_SECRET_ACCESS_KEY,
            sessionToken: S3_SESSION_TOKEN || undefined
          }
        : undefined
    })
  : null;

function sanitizeTimeoutSec(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.max(1, Math.min(MAX_TIMEOUT_SEC, parsed));
}

function parseUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function normalizePrefix(prefix) {
  const trimmed = String(prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? trimmed : "archives";
}

function slugify(value, fallback = "item", maxLen = 80) {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return fallback;
  return normalized.slice(0, maxLen);
}

function ensureHtmlExtension(objectKey) {
  const cleaned = String(objectKey ?? "").replace(/^\/+/, "").trim();
  if (!cleaned) return "";
  if (/\.html?$/i.test(cleaned)) return cleaned;
  return `${cleaned}.html`;
}

function shortUrlHash(urlString) {
  return createHash("sha256").update(urlString).digest("hex").slice(0, 10);
}

function buildObjectKey(targetUrl, customKey) {
  if (customKey && typeof customKey === "string") {
    const explicitKey = ensureHtmlExtension(customKey);
    if (explicitKey) return explicitKey;
  }

  const prefix = normalizePrefix(S3_PREFIX);
  const host = slugify(targetUrl.hostname, "site", 120);
  const pathSegments = targetUrl.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => slugify(segment))
    .slice(0, 12);
  const hasTrailingSlash = targetUrl.pathname.endsWith("/");
  const pathStem =
    pathSegments.length === 0 || hasTrailingSlash
      ? [...pathSegments, "index"].join("/")
      : pathSegments.join("/");
  const querySuffix = targetUrl.search
    ? `--q-${shortUrlHash(targetUrl.search)}`
    : "";
  const urlSuffix = `--${shortUrlHash(targetUrl.toString())}.html`;
  const stemWithSuffix = `${pathStem}${querySuffix}${urlSuffix}`;
  return `${prefix}/${host}/${stemWithSuffix}`;
}

function runMonolith({
  targetUrl,
  outputPath,
  timeoutSec,
  isolate,
  ignoreNetworkErrors,
  excludeJavascript,
  userAgent
}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const args = [];

    if (isolate) args.push("-I");
    if (ignoreNetworkErrors) args.push("-e");
    if (excludeJavascript) args.push("-j");
    if (userAgent) args.push("-u", userAgent);

    args.push("-t", String(timeoutSec));
    args.push(targetUrl.toString(), "-o", outputPath);

    const child = spawn(MONOLITH_BIN, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    let timeoutTriggered = false;
    const hardTimeoutMs = timeoutSec * 1000 + 5_000;
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGKILL");
    }, hardTimeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (code === 0 && !timeoutTriggered) {
        resolve({
          args,
          durationMs,
          stderr: stderr.trim()
        });
        return;
      }

      const reason = timeoutTriggered
        ? `monolith exceeded ${hardTimeoutMs}ms and was killed`
        : `monolith exited with code ${code ?? "unknown"} signal ${signal ?? "none"}`;
      reject(new Error(`${reason}\n${stderr.trim()}`.trim()));
    });
  });
}

async function uploadToS3(filePath, objectKey) {
  if (!s3Enabled || !s3Client || !S3_BUCKET) {
    throw new Error(
      "S3 is not configured. Set S3_BUCKET, S3_REGION, and Supabase S3 credentials."
    );
  }

  const body = fs.createReadStream(filePath);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: objectKey,
      Body: body,
      ContentType: "text/html; charset=utf-8",
      ContentDisposition: "inline"
    })
  );
}

function requestInput(req) {
  const source = req.method === "POST" ? req.body : req.query;
  return {
    url: source.url,
    timeoutSec: sanitizeTimeoutSec(source.timeoutSec),
    isolate: parseBool(source.isolate, true),
    ignoreNetworkErrors: parseBool(source.ignoreErrors, true),
    excludeJavascript: parseBool(source.excludeJavascript, false),
    store: parseBool(source.store, false),
    key: source.key,
    userAgent: source.userAgent
  };
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "plinky-monolith-render",
    endpoints: {
      health: "GET /health",
      archive_get:
        "GET /archive?url=https://example.com&store=1&timeoutSec=60&isolate=1",
      archive_post: "POST /archive { url, store?, timeoutSec?, key? }"
    },
    s3Enabled
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    monolithBin: MONOLITH_BIN,
    s3Enabled,
    s3EndpointConfigured: Boolean(S3_ENDPOINT),
    s3ForcePathStyle: inferForcePathStyle(
      S3_ENDPOINT,
      S3_FORCE_PATH_STYLE_ENV
    )
  });
});

app.all("/archive", async (req, res) => {
  if (!["GET", "POST"].includes(req.method)) {
    res.status(405).json({ error: "Use GET or POST" });
    return;
  }

  const input = requestInput(req);
  const targetUrl = parseUrl(input.url);
  if (!targetUrl) {
    res
      .status(400)
      .json({ error: "Invalid or missing url (must be http/https)" });
    return;
  }

  const tmpName = `${randomUUID()}.html`;
  const outputPath = path.join(tmpdir(), tmpName);

  try {
    const result = await runMonolith({
      targetUrl,
      outputPath,
      timeoutSec: input.timeoutSec,
      isolate: input.isolate,
      ignoreNetworkErrors: input.ignoreNetworkErrors,
      excludeJavascript: input.excludeJavascript,
      userAgent: input.userAgent
    });

    const stat = await fsp.stat(outputPath);

    if (input.store) {
      const key = buildObjectKey(targetUrl, input.key);
      await uploadToS3(outputPath, key);

      res.json({
        ok: true,
        sourceUrl: targetUrl.toString(),
        key,
        bucket: S3_BUCKET,
        sizeBytes: stat.size,
        durationMs: result.durationMs,
        monolithArgs: result.args,
        monolithStderr: result.stderr || null
      });
      return;
    }

    const htmlBytes = await fsp.readFile(outputPath);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-monolith-duration-ms", String(result.durationMs));
    if (result.stderr) {
      res.setHeader("x-monolith-stderr-bytes", String(result.stderr.length));
    }
    res.status(200).send(htmlBytes);
  } catch (error) {
    res.status(502).json({
      error: "Monolith archiving failed",
      detail: error instanceof Error ? error.message : String(error),
      config: {
        timeoutSec: input.timeoutSec,
        isolate: input.isolate,
        ignoreNetworkErrors: input.ignoreNetworkErrors,
        excludeJavascript: input.excludeJavascript
      }
    });
  } finally {
    try {
      await fsp.unlink(outputPath);
    } catch {
      // Intentionally ignore cleanup failures.
    }
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`monolith-render listening on port ${PORT}`);
});
