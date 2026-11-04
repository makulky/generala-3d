import { describe, expect, it } from 'vitest';
import { deriveRelay, seal, unseal } from './relay';

describe('cifrado del respaldo', () => {
  const body = new TextEncoder().encode('{"k":"ready"}');

  it('recupera el contenido con la misma sala', async () => {
    const a = await deriveRelay('ABCDEFGHJK');
    const b = await deriveRelay('ABCDEFGHJK');
    expect(a.channel).toBe(b.channel);
    const out = await unseal(b.key, await seal(a.key, 1, body));
    expect(out?.kind).toBe(1);
    expect(new TextDecoder().decode(out!.body)).toBe('{"k":"ready"}');
  });

  it('rechaza otra sala y los paquetes manipulados', async () => {
    const a = await deriveRelay('ABCDEFGHJK');
    const other = await deriveRelay('ZZZZZZZZZZ');
    expect(a.channel).not.toBe(other.channel);
    const packet = await seal(a.key, 0, body);
    expect(await unseal(other.key, packet)).toBeNull();
    const tampered = packet.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(await unseal(a.key, tampered)).toBeNull();
    expect(await unseal(a.key, new Uint8Array(4))).toBeNull();
  });

  it('el canal público no revela el código ni el contenido viaja en claro', async () => {
    const a = await deriveRelay('ABCDEFGHJK');
    expect(a.channel).not.toContain('ABCDEFGHJK');
    const packet = await seal(a.key, 0, body);
    expect(new TextDecoder('latin1').decode(packet)).not.toContain('ready');
  });
});
