import dns from "node:dns/promises";

import { HttpError } from "./errors.mjs";

export async function validateRenderTargetUrl(
  value,
  {
    allowedHosts = new Set(),
    resolve4 = dns.resolve4.bind(dns),
    resolve6 = dns.resolve6.bind(dns),
  } = {},
) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "url must be a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "url must use http or https");
  }

  if (parsed.username || parsed.password) {
    throw new HttpError(400, "url must not include credentials");
  }

  const defaultPort = parsed.protocol === "http:" ? "80" : "443";
  if (parsed.port && parsed.port !== defaultPort) {
    throw new HttpError(400, "url must use the default port");
  }
  if (parsed.port === defaultPort) {
    parsed.port = "";
  }
  parsed.hash = "";

  const host = normalizeHost(parsed.hostname);
  if (!host) {
    throw new HttpError(400, "url must include a host");
  }

  if (allowedHosts.size > 0 && !allowedHosts.has(host)) {
    throw new HttpError(403, "host is not allowed by renderer policy");
  }

  if (isDisallowedHostname(host)) {
    throw new HttpError(403, "host is not allowed");
  }

  if (isIpLiteral(host)) {
    if (!isPublicIpLiteral(host)) {
      throw new HttpError(403, "host must resolve to a public address");
    }

    return { url: parsed.toString(), host };
  }

  const resolvedAddresses = await resolveHostAddresses(host, {
    resolve4,
    resolve6,
  });
  if (resolvedAddresses.length === 0) {
    throw new HttpError(400, "host could not be resolved");
  }

  for (const address of resolvedAddresses) {
    if (!isPublicIpLiteral(address)) {
      throw new HttpError(403, "host must resolve to a public address");
    }
  }

  return { url: parsed.toString(), host };
}

export function isPublicIpLiteral(host) {
  const normalized = normalizeHost(host);
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isPublicIpv4(ipv4);
  }

  const ipv6 = parseIpv6(normalized);
  if (ipv6) {
    return isPublicIpv6(ipv6);
  }

  return false;
}

function normalizeHost(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isDisallowedHostname(host) {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  return !host.includes(".") && !isIpLiteral(host);
}

function isIpLiteral(host) {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

async function resolveHostAddresses(host, { resolve4, resolve6 }) {
  const addresses = new Set();

  for (const resolver of [resolve4, resolve6]) {
    try {
      const results = await resolver(host);
      for (const result of results) {
        addresses.add(normalizeHost(result));
      }
    } catch (error) {
      if (isDnsNoDataError(error)) {
        continue;
      }

      throw new HttpError(502, "host could not be resolved");
    }
  }

  return [...addresses];
}

function isDnsNoDataError(error) {
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();
  return message.includes("no data") ||
    message.includes("nodata") ||
    message.includes("not found") ||
    message.includes("nxdomain") ||
    message.includes("enodata") ||
    message.includes("enotfound");
}

function parseIpv4(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return null;
  }

  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return parts;
}

function isPublicIpv4(parts) {
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) {
    return false;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }
  if (a === 192 && b === 168) {
    return false;
  }
  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return false;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return false;
  }
  if (a === 198 && b === 51 && c === 100) {
    return false;
  }
  if (a === 203 && b === 0 && c === 113) {
    return false;
  }
  if (a >= 224 || a >= 240) {
    return false;
  }

  return true;
}

function parseIpv6(host) {
  let normalized = host.trim().toLowerCase();
  if (!normalized.includes(":")) {
    return null;
  }
  if (normalized.includes("%")) {
    return null;
  }

  let ipv4Tail = null;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) {
      return null;
    }

    ipv4Tail = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4Tail) {
      return null;
    }

    normalized = `${normalized.slice(0, lastColon)}:${
      ((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16)
    }:${((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16)}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":").filter(Boolean)
    : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(":").filter(Boolean)
    : [];
  const missing = 8 - (left.length + right.length);
  if ((doubleColonParts.length === 1 && left.length !== 8) || missing < 0) {
    return null;
  }

  const groups = [
    ...left,
    ...Array(doubleColonParts.length === 2 ? missing : 0).fill("0"),
    ...right,
  ];
  if (groups.length !== 8) {
    return null;
  }

  const values = groups.map((group) => Number.parseInt(group, 16));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) {
    return null;
  }

  return values;
}

function isPublicIpv6(groups) {
  const first = groups[0];

  if (first === 0 || first === 0xfe80 || (first & 0xffc0) === 0xfe80) {
    return false;
  }
  if ((first & 0xfe00) === 0xfc00) {
    return false;
  }
  if ((first & 0xff00) === 0xff00) {
    return false;
  }
  if (
    groups.every((group, index) => (index === 7 ? group === 1 : group === 0))
  ) {
    return false;
  }

  return true;
}
