import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIN_LENGTH, isValidPin, isWeakPin, createPinRecord, checkPin, lockoutMs, formatWait } from '../app/js/lock.js';

test('PIN: формат', () => {
  assert.equal(PIN_LENGTH, 4);
  assert.ok(isValidPin('2580'));
  for (const bad of ['', '123', '12345', 'abcd', '12a4', ' 258', null]) assert.equal(isValidPin(bad), false, String(bad));
});

test('PIN: слишком простые отклоняются', () => {
  for (const weak of ['0000', '7777', '1234', '6789', '4321', '9876', '0123']) assert.ok(isWeakPin(weak), weak);
  for (const ok of ['2580', '1379', '1122', '9021']) assert.equal(isWeakPin(ok), false, ok);
});

test('PIN: хранится только хэш с солью, проверка работает', async () => {
  const rec = await createPinRecord('2580');
  assert.ok(!JSON.stringify(rec).includes('2580'), 'PIN не хранится открытым');
  assert.ok(rec.salt && rec.hash && rec.iterations >= 100_000);
  assert.equal(await checkPin('2580', rec), true);
  assert.equal(await checkPin('2581', rec), false);
  assert.equal(await checkPin('', rec), false);
  const rec2 = await createPinRecord('2580');
  assert.notEqual(rec.hash, rec2.hash, 'соль делает хэши разными');
});

test('пауза после неудачных попыток растёт и ограничена часом', () => {
  assert.equal(lockoutMs(4), 0);
  assert.equal(lockoutMs(5), 30_000);
  assert.equal(lockoutMs(6), 60_000);
  assert.equal(lockoutMs(8), 240_000);
  assert.equal(lockoutMs(50), 3_600_000);
  assert.equal(formatWait(29_100), '30 с');
  assert.equal(formatWait(90_000), '1 мин 30 с');
  assert.equal(formatWait(120_000), '2 мин');
});
