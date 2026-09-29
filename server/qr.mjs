import QRCode from 'qrcode';

export const MAX_ENROLLMENT_URI_BYTES = 1024;
const INVALID_URI = 'Некорректная ссылка настройки приложения-аутентификатора.';

function validateEnrollmentUri(uri) {
  if (typeof uri !== 'string' || Buffer.byteLength(uri, 'utf8') > MAX_ENROLLMENT_URI_BYTES || /[\u0000-\u001f\u007f]/.test(uri)) {
    throw new Error(INVALID_URI);
  }
  try {
    const parsed = new URL(uri);
    const label = decodeURIComponent(parsed.pathname.slice(1));
    if (parsed.protocol !== 'otpauth:' || parsed.hostname !== 'totp' || parsed.username || parsed.password
      || parsed.port || parsed.hash || !label.trim() || /[\u0000-\u001f\u007f]/.test(label)
      || parsed.searchParams.getAll('secret').length !== 1
      || !/^[A-Z2-7]{16,128}$/.test(parsed.searchParams.get('secret'))) throw new Error();
  } catch {
    // Never include a URI, secret, URL parser error or nested cause in an error.
    throw new Error(INVALID_URI);
  }
}

/**
 * Encode a server-created TOTP enrollment URI in memory. No requests, files or
 * logs are produced. The caller must return this secret-bearing image only to
 * the authorized enrollment challenge, with Cache-Control: no-store.
 */
export async function enrollmentQr(uri) {
  validateEnrollmentUri(uri);
  try {
    return await QRCode.toDataURL(uri, {
      type: 'image/png', width: 400, margin: 4, errorCorrectionLevel: 'M',
      color: { dark: '#2B2B2BFF', light: '#FFFFFFFF' },
    });
  } catch {
    throw new Error('Не удалось сформировать QR-код настройки.');
  }
}
