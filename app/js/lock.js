// PIN-код на вход и разблокировка по Face ID / Touch ID.
// Это защита от человека с твоим разблокированным телефоном, а не шифрование:
// данные в IndexedDB лежат как раньше. Сам PIN нигде не хранится — только
// его хэш PBKDF2 с солью (PIN часто совпадает с PIN карты, светить его нельзя).

export const PIN_LENGTH = 4;
const ITERATIONS = 300_000;

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const isValidPin = (pin) => typeof pin === 'string' && pin.length === PIN_LENGTH && /^\d+$/.test(pin);

// 0000, 1234, 9876 и подобные угадываются с первой попытки
export function isWeakPin(pin) {
  const d = [...pin].map(Number);
  const same = d.every((x) => x === d[0]);
  const up = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const down = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  return same || up || down;
}

export async function hashPin(pin, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toB64(bits);
}

export async function createPinRecord(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toB64(salt), hash: await hashPin(pin, salt), iterations: ITERATIONS };
}

export async function checkPin(pin, record) {
  if (!isValidPin(pin) || !record?.hash) return false;
  const hash = await hashPin(pin, fromB64(record.salt), record.iterations);
  let diff = hash.length ^ record.hash.length;
  for (let i = 0; i < Math.min(hash.length, record.hash.length); i++) diff |= hash.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}

// Пауза после неудачных попыток: первые 4 бесплатно, потом 30 с, 1 мин, 2 мин… до часа
export function lockoutMs(failures) {
  if (failures < 5) return 0;
  return Math.min(30_000 * 2 ** (failures - 5), 3_600_000);
}

export function formatWait(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} мин ${rest} с` : `${m} мин`;
}

// ---------- Face ID / Touch ID через passkey (WebAuthn) ----------
// Сервера нет, поэтому подпись не проверяем: нам нужно только, чтобы
// система подтвердила личность (флаг UV) именно для нашего запроса.

export async function biometricAvailable() {
  try {
    return Boolean(window.PublicKeyCredential) && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export function biometricName(ua = navigator.userAgent) {
  if (/iPhone|iPad/.test(ua)) return 'Face ID / Touch ID';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return 'биометрии';
}

// Вызывать прямо из обработчика нажатия: Safari требует жест пользователя
export async function registerBiometric() {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Трекер расходов' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Трекер расходов', displayName: 'Трекер расходов' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      attestation: 'none',
      timeout: 60_000,
    },
  });
  return toB64(cred.rawId);
}

export async function verifyBiometric(credentialId) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: 'public-key', id: fromB64(credentialId), transports: ['internal', 'hybrid'] }],
      userVerification: 'required',
      timeout: 60_000,
    },
  });
  if (!assertion) return false;
  const client = JSON.parse(new TextDecoder().decode(assertion.response.clientDataJSON));
  const expected = toB64(challenge).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const flags = new Uint8Array(assertion.response.authenticatorData)[32];
  return client.type === 'webauthn.get' && client.challenge === expected && client.origin === location.origin && (flags & 0x04) !== 0;
}
