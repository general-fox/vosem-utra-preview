import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateItems } from '../server/menu-api.mjs';
import { phpBinary, phpEnvironment } from '../scripts/php-runtime.mjs';

const dish = { id:'toast', name:'Тост', description:'Хлеб, яйцо и зелень', price:450, category:'breakfast', image:'', published:true, availableForOrder:true, order:0 };
test('optional dish nutrition and allergens preserve legacy shape and accept independently edited text', () => {
  assert.deepEqual(validateItems([dish])[0], dish);
  const actual = validateItems([{ ...dish, nutrition:'  420 ккал\nБ: 14 г, Ж: 22 г, У: 39 г  ', allergens:'  Яйцо, молоко\nГлютен  ' }])[0];
  assert.equal(actual.description, dish.description);
  assert.equal(actual.nutrition, '420 ккал\nБ: 14 г, Ж: 22 г, У: 39 г');
  assert.equal(actual.allergens, 'Яйцо, молоко\nГлютен');
  assert.deepEqual(validateItems([{ ...dish, nutrition:' \n ', allergens:'' }])[0], { ...dish, nutrition:'', allergens:'' });
  for (const [key, limit] of [['nutrition',500],['allergens',1000]]) {
    assert.equal(validateItems([{ ...dish, [key]:'я'.repeat(limit) }])[0][key].length,limit);
    assert.equal(validateItems([{ ...dish, [key]:'🍽'.repeat(limit/2) }])[0][key].length,limit);
    assert.equal(Object.hasOwn(validateItems([{ ...dish, [key]:'' }])[0],key==='nutrition'?'allergens':'nutrition'),false);
  }
});

test('dish metadata rejects malformed values, forbidden controls and over-limit strings', () => {
  for (const [key, limit] of [['nutrition',500],['allergens',1000]]) {
    for (const value of [null,undefined,false,123,[],{},'bad\u0000value','bad\u007fvalue','я'.repeat(limit+1),'🍽'.repeat(limit/2+1),' '.repeat(limit+1)]) {
      assert.throws(()=>validateItems([{ ...dish, [key]:value }]),error=>error.status===400 && error.code==='invalid_item',key+': '+JSON.stringify(value));
    }
  }
});

test('PHP saves dish metadata, exposes it publicly and preserves it through encrypted transfer', {timeout:30000}, () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const result=spawnSync(phpBinary,['tests/php-menu-metadata.php'],{cwd:root,env:phpEnvironment,encoding:'utf8',windowsHide:true,timeout:25000});
  assert.equal(result.status,0,String(result.error||'')+result.stdout+result.stderr);
  assert.match(result.stdout,/PASS/);
});
