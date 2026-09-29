import { randomBytes } from 'node:crypto';

export function securityHeaders(res, { production = false, publicOrigin = '' } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (production && publicOrigin.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

export function secureHtml(html, res) {
  const nonce = randomBytes(24).toString('base64');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self'", "connect-src 'self'", "object-src 'none'",
    "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '));
  return html.replace(/<script\b([^>]*)>/gi, (_, attributes) =>
    `<script${attributes.replace(/\s+nonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')} nonce="${nonce}">`);
}
